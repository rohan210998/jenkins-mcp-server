#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios, { AxiosInstance } from 'axios';

const JENKINS_URL  = process.env.JENKINS_URL  || '';
const JENKINS_USER = process.env.JENKINS_USER || '';
const JENKINS_TOKEN= process.env.JENKINS_TOKEN|| '';

// ─── Types ────────────────────────────────────────────────────────────────────
interface FlatJob {
  name: string; fullPath: string; url: string;
  lastBuild: { number: number; result: string; url: string } | null;
  isFolder: boolean;
}

// ─── Shared tool schema helpers ────────────────────────────────────────────────
const jobPathProp    = { jobPath:    { type: 'string', description: 'Path to the Jenkins job' } };
const buildNumProp   = { buildNumber:{ type: 'string', description: 'Build number or "lastBuild"', default: 'lastBuild' } };
const limitProp      = { limit:      { type: 'number', description: 'Max results to return (default 10)', default: 10 } };

class JenkinsServer {
  private server: Server;
  private http: AxiosInstance;
  private crumbCache: { field: string; value: string; ts: number } | null = null;

  constructor() {
    this.server = new Server(
      { name: 'jenkins-server', version: '0.3.0' },
      { capabilities: { tools: {} } }
    );
    this.http = axios.create({
      baseURL: JENKINS_URL,
      auth: { username: JENKINS_USER, password: JENKINS_TOKEN },
      timeout: 30_000,
    });
    this.setupToolHandlers();
    this.server.onerror = (err) => console.error('[MCP Error]', err);
    process.on('SIGINT', async () => { await this.server.close(); process.exit(0); });
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /** "FolderA/Sub/Job"  →  "job/FolderA/job/Sub/job/Job" */
  private toJenkinsPath(path: string): string {
    return path.split('/').map(s => s.trim()).filter(Boolean)
      .map(s => `job/${encodeURIComponent(s)}`).join('/');
  }

  /** Cached crumb (5-min TTL) to reduce round-trips */
  private async getCrumb(): Promise<Record<string, string>> {
    const now = Date.now();
    if (this.crumbCache && now - this.crumbCache.ts < 5 * 60_000) {
      return { [this.crumbCache.field]: this.crumbCache.value };
    }
    const r = await this.http.get('/crumbIssuer/api/json');
    this.crumbCache = { field: r.data.crumbRequestField, value: r.data.crumb, ts: now };
    return { [r.data.crumbRequestField]: r.data.crumb };
  }

  /** POST helper — always fetches fresh crumb header */
  private async post(path: string, body: Record<string,string> | null = null) {
    const crumb = await this.getCrumb();
    if (body && Object.keys(body).length) {
      const params = new URLSearchParams(body);
      return this.http.post(path, params, {
        headers: { ...crumb, 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    }
    return this.http.post(path, {}, { headers: crumb });
  }

  private ok(text: string)  { return { content: [{ type: 'text', text }] }; }
  private json(data: unknown){ return this.ok(JSON.stringify(data, null, 2)); }

  // ─── Tool Registration ───────────────────────────────────────────────────────
  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        // ── Status & Info ──────────────────────────────────────────────────────
        {
          name: 'get_build_status',
          description: 'Get the status of a specific (or last) build for a job.',
          inputSchema: { type: 'object', properties: { ...jobPathProp, ...buildNumProp }, required: ['jobPath'] },
        },
        {
          name: 'list_all_jobs',
          description: 'List all top-level Jenkins jobs with their last build status.',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
        {
          name: 'list_folder_jobs',
          description: 'Recursively list all jobs inside a Jenkins folder (up to 4 levels deep).',
          inputSchema: {
            type: 'object',
            properties: { folderPath: { type: 'string', description: 'E.g. "CS" or "CS/PP"' } },
            required: ['folderPath'],
          },
        },
        {
          name: 'list_recent_failed_jobs',
          description: 'List jobs whose last build failed, sorted by most recent failure.',
          inputSchema: { type: 'object', properties: { ...limitProp }, required: [] },
        },
        {
          name: 'count_failed_jobs',
          description: 'Count jobs whose last build is in FAILURE state.',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
        {
          name: 'search_jobs',
          description: 'Case-insensitive substring search across all top-level job names.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Substring to search for' },
              caseSensitive: { type: 'boolean', default: false },
            },
            required: ['query'],
          },
        },
        {
          name: 'get_job_parameters',
          description: 'Show all parameter definitions for a job before triggering it.',
          inputSchema: { type: 'object', properties: { ...jobPathProp }, required: ['jobPath'] },
        },
        // ── Logs ──────────────────────────────────────────────────────────────
        {
          name: 'get_build_log',
          description: 'Get the full console output of a build.',
          inputSchema: { type: 'object', properties: { ...jobPathProp, ...buildNumProp }, required: ['jobPath', 'buildNumber'] },
        },
        {
          name: 'get_failed_build_log',
          description: 'Shortcut: get the console output of the last *failed* build.',
          inputSchema: { type: 'object', properties: { ...jobPathProp }, required: ['jobPath'] },
        },
        {
          name: 'get_build_log_tail',   // NEW
          description: 'Get only the last N lines of a build\'s console output — faster for large logs.',
          inputSchema: {
            type: 'object',
            properties: {
              ...jobPathProp, ...buildNumProp,
              lines: { type: 'number', description: 'Number of tail lines (default 100)', default: 100 },
            },
            required: ['jobPath'],
          },
        },
        // ── Trigger & Control ─────────────────────────────────────────────────
        {
          name: 'trigger_build',
          description: 'Trigger a Jenkins build, optionally with parameters.',
          inputSchema: {
            type: 'object',
            properties: {
              ...jobPathProp,
              parameters: { type: 'object', additionalProperties: true },
            },
            required: ['jobPath'],
          },
        },
        {
          name: 'abort_build',
          description: 'Abort a currently running build.',
          inputSchema: { type: 'object', properties: { ...jobPathProp, ...buildNumProp }, required: ['jobPath'] },
        },
        {
          name: 'retry_failed_build',
          description: 'Re-trigger the last failed build with the same parameters.',
          inputSchema: { type: 'object', properties: { ...jobPathProp }, required: ['jobPath'] },
        },
        {
          name: 'bulk_trigger',
          description: 'Trigger multiple jobs in one call.',
          inputSchema: {
            type: 'object',
            properties: {
              jobs: {
                type: 'array',
                items: { type: 'object', properties: { ...jobPathProp, parameters: { type: 'object', additionalProperties: true } }, required: ['jobPath'] },
              },
            },
            required: ['jobs'],
          },
        },
        {
          name: 'toggle_job',
          description: 'Enable or disable a Jenkins job.',
          inputSchema: {
            type: 'object',
            properties: { ...jobPathProp, action: { type: 'string', enum: ['enable', 'disable'] } },
            required: ['jobPath', 'action'],
          },
        },
        {
          name: 'copy_job',           // NEW
          description: 'Copy (clone) an existing Jenkins job to a new name.',
          inputSchema: {
            type: 'object',
            properties: {
              sourceJobPath: { type: 'string', description: 'Existing job path' },
              newJobName:    { type: 'string', description: 'Name for the new job (no slashes)' },
            },
            required: ['sourceJobPath', 'newJobName'],
          },
        },
        {
          name: 'delete_build',       // NEW
          description: 'Permanently delete a specific build record from Jenkins.',
          inputSchema: { type: 'object', properties: { ...jobPathProp, ...buildNumProp }, required: ['jobPath', 'buildNumber'] },
        },
        // ── Monitoring ────────────────────────────────────────────────────────
        {
          name: 'get_running_builds',
          description: 'List all builds currently in progress across the server.',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
        {
          name: 'get_queue_items',
          description: 'Show builds waiting in the Jenkins queue.',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
        {
          name: 'cancel_queue_item',  // NEW
          description: 'Cancel a specific item waiting in the Jenkins queue.',
          inputSchema: {
            type: 'object',
            properties: { itemId: { type: 'number', description: 'Queue item ID (from get_queue_items)' } },
            required: ['itemId'],
          },
        },
        {
          name: 'get_build_history',
          description: 'Get the last N builds for a job with result, duration, and stability %.',
          inputSchema: { type: 'object', properties: { ...jobPathProp, ...limitProp }, required: ['jobPath'] },
        },
        {
          name: 'get_build_changes',
          description: 'Show SCM commits included in a specific build.',
          inputSchema: { type: 'object', properties: { ...jobPathProp, ...buildNumProp }, required: ['jobPath'] },
        },
        {
          name: 'get_build_artifacts', // NEW
          description: 'List artifacts produced by a build (name + download URL).',
          inputSchema: { type: 'object', properties: { ...jobPathProp, ...buildNumProp }, required: ['jobPath'] },
        },
        {
          name: 'get_build_timings',   // NEW
          description: 'Return start time, duration, and estimated remaining time for a build.',
          inputSchema: { type: 'object', properties: { ...jobPathProp, ...buildNumProp }, required: ['jobPath'] },
        },
        // ── Test & Quality ────────────────────────────────────────────────────
        {
          name: 'get_test_results',
          description: 'Fetch pass/fail/skip counts and failed test names from a build.',
          inputSchema: { type: 'object', properties: { ...jobPathProp, ...buildNumProp }, required: ['jobPath'] },
        },
        {
          name: 'get_flaky_tests',     // NEW
          description: 'Identify tests that flip between PASS and FAIL across the last N builds.',
          inputSchema: {
            type: 'object',
            properties: { ...jobPathProp, ...limitProp },
            required: ['jobPath'],
          },
        },
        // ── Nodes / Infrastructure ────────────────────────────────────────────
        {
          name: 'get_nodes',
          description: 'List all Jenkins agents with online/offline status, executors, and labels.',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
        {
          name: 'toggle_node',         // NEW
          description: 'Take a node online or mark it temporarily offline.',
          inputSchema: {
            type: 'object',
            properties: {
              nodeName: { type: 'string', description: 'Node display name (exact match)' },
              action:   { type: 'string', enum: ['online', 'offline'], description: '"online" or "offline"' },
              reason:   { type: 'string', description: 'Reason message when going offline (optional)' },
            },
            required: ['nodeName', 'action'],
          },
        },
        // ── Server Health ─────────────────────────────────────────────────────
        {
          name: 'get_server_info',     // NEW
          description: 'Return Jenkins version, number of executors, load statistics, and quiet-down status.',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
        {
          name: 'quiet_down',          // NEW
          description: 'Put the Jenkins server into quiet-down (preparation for shutdown) or cancel it.',
          inputSchema: {
            type: 'object',
            properties: { action: { type: 'string', enum: ['start', 'cancel'] } },
            required: ['action'],
          },
        },
        // ── Users ─────────────────────────────────────────────────────────────
        {
          name: 'create_jenkins_user',
          description: 'Create a new Jenkins user (requires admin permissions).',
          inputSchema: {
            type: 'object',
            properties: {
              username: { type: 'string' }, password: { type: 'string' },
              fullName: { type: 'string' }, email: { type: 'string' },
            },
            required: ['username', 'password'],
          },
        },
        {
          name: 'list_users',          // NEW
          description: 'List all Jenkins users.',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const a = req.params.arguments as any;
      try {
        switch (req.params.name) {
          // Status & Info
          case 'get_build_status':        return await this.getBuildStatus(a);
          case 'list_all_jobs':           return await this.listAllJobs();
          case 'list_folder_jobs':        return await this.listFolderJobs(a);
          case 'list_recent_failed_jobs': return await this.listRecentFailedJobs(a);
          case 'count_failed_jobs':       return await this.countFailedJobs();
          case 'search_jobs':             return await this.searchJobs(a);
          case 'get_job_parameters':      return await this.getJobParameters(a);
          // Logs
          case 'get_build_log':           return await this.getBuildLog(a);
          case 'get_failed_build_log':    return await this.getFailedBuildLog(a);
          case 'get_build_log_tail':      return await this.getBuildLogTail(a);
          // Trigger & Control
          case 'trigger_build':           return await this.triggerBuild(a);
          case 'abort_build':             return await this.abortBuild(a);
          case 'retry_failed_build':      return await this.retryFailedBuild(a);
          case 'bulk_trigger':            return await this.bulkTrigger(a);
          case 'toggle_job':              return await this.toggleJob(a);
          case 'copy_job':                return await this.copyJob(a);
          case 'delete_build':            return await this.deleteBuild(a);
          // Monitoring
          case 'get_running_builds':      return await this.getRunningBuilds();
          case 'get_queue_items':         return await this.getQueueItems();
          case 'cancel_queue_item':       return await this.cancelQueueItem(a);
          case 'get_build_history':       return await this.getBuildHistory(a);
          case 'get_build_changes':       return await this.getBuildChanges(a);
          case 'get_build_artifacts':     return await this.getBuildArtifacts(a);
          case 'get_build_timings':       return await this.getBuildTimings(a);
          // Test & Quality
          case 'get_test_results':        return await this.getTestResults(a);
          case 'get_flaky_tests':         return await this.getFlakyTests(a);
          // Nodes
          case 'get_nodes':               return await this.getNodes();
          case 'toggle_node':             return await this.toggleNode(a);
          // Server Health
          case 'get_server_info':         return await this.getServerInfo();
          case 'quiet_down':              return await this.quietDown(a);
          // Users
          case 'create_jenkins_user':     return await this.createJenkinsUser(a);
          case 'list_users':              return await this.listUsers();
          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${req.params.name}`);
        }
      } catch (err: any) {
        if (err instanceof McpError) throw err;
        if (axios.isAxiosError(err)) {
          throw new McpError(
            ErrorCode.InternalError,
            `Jenkins API error [${err.response?.status}]: ${err.response?.data?.message || err.message}`
          );
        }
        throw new McpError(ErrorCode.InternalError, String(err?.message ?? 'Unknown error'));
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATUS & INFO
  // ═══════════════════════════════════════════════════════════════════════════
  private async getBuildStatus(a: any) {
    const num = a.buildNumber || 'lastBuild';
    const r = await this.http.get(`/${a.jobPath}/${num}/api/json`);
    return this.json({
      number: r.data.number,
      building: r.data.building,
      result: r.data.result,
      startedAt: new Date(r.data.timestamp).toISOString(),
      durationSeconds: Math.floor(r.data.duration / 1000),
      url: r.data.url,
    });
  }

  private async listAllJobs() {
    const r = await this.http.get('/api/json', {
      params: { tree: 'jobs[name,url,color,lastBuild[number,result,url]]' },
    });
    const jobs = (r.data.jobs || []).map((j: any) => ({
      name: j.name, url: j.url, statusColor: j.color,
      lastBuild: j.lastBuild ? { number: j.lastBuild.number, result: j.lastBuild.result, url: j.lastBuild.url } : null,
    }));
    return this.json({ count: jobs.length, jobs });
  }

  private async listFolderJobs(a: any) {
    const folderPath: string = a?.folderPath ?? '';
    if (!folderPath.trim()) throw new McpError(ErrorCode.InvalidParams, 'folderPath is required');
    const apiPath = this.toJenkinsPath(folderPath);
    const tree =
      'jobs[name,url,color,lastBuild[number,result,url],' +
        'jobs[name,url,color,lastBuild[number,result,url],' +
          'jobs[name,url,color,lastBuild[number,result,url],' +
            'jobs[name,url,color,lastBuild[number,result,url]]]]]';
    const r = await this.http.get(`/${apiPath}/api/json`, { params: { tree } });
    const flat: FlatJob[] = [];
    const flatten = (jobs: any[], parent: string) => {
      for (const j of jobs) {
        const fullPath = parent ? `${parent}/${j.name}` : j.name;
        const isFolder = Array.isArray(j.jobs);
        flat.push({ name: j.name, fullPath, url: j.url,
          lastBuild: j.lastBuild ? { number: j.lastBuild.number, result: j.lastBuild.result, url: j.lastBuild.url } : null,
          isFolder });
        if (isFolder && j.jobs.length) flatten(j.jobs, fullPath);
      }
    };
    flatten(r.data.jobs || [], folderPath);
    return this.json({
      folderPath, totalItems: flat.length,
      jobCount: flat.filter(j => !j.isFolder).length,
      folderCount: flat.filter(j => j.isFolder).length,
      jobs: flat,
    });
  }

  private async listRecentFailedJobs(a: any) {
    const limit = a?.limit ?? 10;
    const r = await this.http.get('/api/json', {
      params: { tree: 'jobs[name,url,lastBuild[number,result,timestamp,url]]' },
    });
    const failed = (r.data.jobs || [])
      .filter((j: any) => j.lastBuild?.result === 'FAILURE')
      .sort((x: any, y: any) => y.lastBuild.timestamp - x.lastBuild.timestamp)
      .slice(0, limit)
      .map((j: any) => ({
        name: j.name, jobUrl: j.url,
        buildNumber: j.lastBuild.number, result: j.lastBuild.result,
        failedAt: new Date(j.lastBuild.timestamp).toISOString(),
        buildUrl: j.lastBuild.url,
      }));
    return this.json({ count: failed.length, failedJobs: failed });
  }

  private async countFailedJobs() {
    const r = await this.http.get('/api/json', { params: { tree: 'jobs[lastBuild[result]]' } });
    const count = (r.data.jobs || []).filter((j: any) => j.lastBuild?.result === 'FAILURE').length;
    return this.json({ failedJobCount: count });
  }

  private async searchJobs(a: any) {
    if (!a?.query) throw new McpError(ErrorCode.InvalidParams, 'query is required');
    const cs: boolean = a.caseSensitive ?? false;
    const r = await this.http.get('/api/json', {
      params: { tree: 'jobs[name,url,color,lastBuild[number,result,url]]' },
    });
    const needle = cs ? a.query : a.query.toLowerCase();
    const matches = (r.data.jobs || [])
      .filter((j: any) => (cs ? j.name : j.name.toLowerCase()).includes(needle))
      .map((j: any) => ({
        name: j.name, url: j.url, statusColor: j.color,
        lastBuildResult: j.lastBuild?.result ?? null, lastBuildNumber: j.lastBuild?.number ?? null,
      }));
    return this.json({ query: a.query, count: matches.length, matches });
  }

  private async getJobParameters(a: any) {
    if (!a?.jobPath) throw new McpError(ErrorCode.InvalidParams, 'jobPath is required');
    const r = await this.http.get(`/${a.jobPath}/api/json`, {
      params: { tree: 'property[parameterDefinitions[name,type,description,defaultParameterValue[value]]]' },
    });
    const defs = (r.data.property || [])
      .flatMap((p: any) => p.parameterDefinitions || [])
      .map((p: any) => ({
        name: p.name, type: p.type, description: p.description || null,
        defaultValue: p.defaultParameterValue?.value ?? null,
      }));
    if (!defs.length) return this.ok(`Job "${a.jobPath}" has no defined parameters.`);
    return this.json({ jobPath: a.jobPath, parameterCount: defs.length, parameters: defs });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LOGS
  // ═══════════════════════════════════════════════════════════════════════════
  private async getBuildLog(a: any) {
    const r = await this.http.get(`/${a.jobPath}/${a.buildNumber}/consoleText`);
    return this.ok(r.data);
  }

  private async getFailedBuildLog(a: any) {
    if (!a?.jobPath) throw new McpError(ErrorCode.InvalidParams, 'jobPath is required');
    const info = await this.http.get(`/${a.jobPath}/api/json`, {
      params: { tree: 'name,lastFailedBuild[number]' },
    });
    const num = info.data.lastFailedBuild?.number;
    if (!num) return this.ok(`Job "${info.data.name}" has no failed builds.`);
    const log = await this.http.get(`/${a.jobPath}/${num}/consoleText`);
    return this.ok(log.data);
  }

  /** NEW: tail last N lines of a build log */
  private async getBuildLogTail(a: any) {
    if (!a?.jobPath) throw new McpError(ErrorCode.InvalidParams, 'jobPath is required');
    const num = a.buildNumber || 'lastBuild';
    const lines = Math.max(1, a.lines ?? 100);
    const r = await this.http.get(`/${a.jobPath}/${num}/consoleText`);
    const tail = (r.data as string).split('\n').slice(-lines).join('\n');
    return this.ok(tail);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TRIGGER & CONTROL
  // ═══════════════════════════════════════════════════════════════════════════
  private async triggerBuild(a: any) {
    if (!a?.jobPath) throw new McpError(ErrorCode.InvalidParams, 'jobPath is required');
    const params = a.parameters && Object.keys(a.parameters).length ? a.parameters : null;
    const entries: Record<string,string> = params
      ? Object.fromEntries(Object.entries(params).map(([k,v]) => [k, String(v)])) : {};
    if (params) {
      await this.post(`/${a.jobPath}/buildWithParameters`, entries);
      return this.ok('Parameterized build triggered successfully.');
    }
    await this.post(`/${a.jobPath}/build`);
    return this.ok('Build triggered successfully.');
  }

  private async abortBuild(a: any) {
    if (!a?.jobPath) throw new McpError(ErrorCode.InvalidParams, 'jobPath is required');
    const num = a.buildNumber || 'lastBuild';
    const status = await this.http.get(`/${a.jobPath}/${num}/api/json`);
    if (!status.data.building) {
      return this.ok(`Build #${status.data.number} is not running (result: ${status.data.result ?? 'unknown'}).`);
    }
    await this.post(`/${a.jobPath}/${status.data.number}/stop`);
    return this.ok(`Build #${status.data.number} of "${a.jobPath}" aborted.`);
  }

  private async retryFailedBuild(a: any) {
    if (!a?.jobPath) throw new McpError(ErrorCode.InvalidParams, 'jobPath is required');
    const info = await this.http.get(`/${a.jobPath}/api/json`, {
      params: { tree: 'lastFailedBuild[number,actions[parameters[name,value]]]' },
    });
    const lastFailed = info.data.lastFailedBuild;
    if (!lastFailed?.number) return this.ok(`No failed builds found for "${a.jobPath}".`);
    const params: Record<string,string> = {};
    for (const action of lastFailed.actions || [])
      for (const p of action.parameters || []) params[p.name] = p.value;
    const hasParams = Object.keys(params).length > 0;
    if (hasParams) await this.post(`/${a.jobPath}/buildWithParameters`, params);
    else           await this.post(`/${a.jobPath}/build`);
    return this.json({ message: `Retried build #${lastFailed.number} of "${a.jobPath}".`, parametersUsed: hasParams ? params : '(none)' });
  }

  private async bulkTrigger(a: any) {
    if (!Array.isArray(a?.jobs) || !a.jobs.length)
      throw new McpError(ErrorCode.InvalidParams, 'jobs array is required');
    const results: Array<{ jobPath: string; status: string; error?: string }> = [];
    for (const job of a.jobs) {
      try {
        const params = job.parameters && Object.keys(job.parameters).length
          ? Object.fromEntries(Object.entries(job.parameters).map(([k,v]) => [k, String(v)])) : null;
        if (params) await this.post(`/${job.jobPath}/buildWithParameters`, params);
        else        await this.post(`/${job.jobPath}/build`);
        results.push({ jobPath: job.jobPath, status: 'triggered' });
      } catch (err: any) {
        results.push({ jobPath: job.jobPath, status: 'failed', error: err?.message ?? 'unknown' });
      }
    }
    const succeeded = results.filter(r => r.status === 'triggered').length;
    return this.json({ summary: { total: results.length, succeeded, failed: results.length - succeeded }, results });
  }

  private async toggleJob(a: any) {
    if (!a?.jobPath) throw new McpError(ErrorCode.InvalidParams, 'jobPath is required');
    if (!['enable','disable'].includes(a.action))
      throw new McpError(ErrorCode.InvalidParams, 'action must be "enable" or "disable"');
    await this.post(`/${a.jobPath}/${a.action}`);
    return this.ok(`Job "${a.jobPath}" ${a.action}d successfully.`);
  }

  /** NEW: copy/clone an existing job */
  private async copyJob(a: any) {
    if (!a?.sourceJobPath || !a?.newJobName)
      throw new McpError(ErrorCode.InvalidParams, 'sourceJobPath and newJobName are required');
    const crumb = await this.getCrumb();
    const params = new URLSearchParams({ name: a.newJobName, mode: 'copy', from: a.sourceJobPath });
    await this.http.post('/createItem', params, {
      headers: { ...crumb, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    return this.ok(`Job "${a.newJobName}" created as a copy of "${a.sourceJobPath}".`);
  }

  /** NEW: delete a specific build record */
  private async deleteBuild(a: any) {
    if (!a?.jobPath || !a?.buildNumber)
      throw new McpError(ErrorCode.InvalidParams, 'jobPath and buildNumber are required');
    await this.post(`/${a.jobPath}/${a.buildNumber}/doDelete`);
    return this.ok(`Build #${a.buildNumber} of "${a.jobPath}" deleted.`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MONITORING
  // ═══════════════════════════════════════════════════════════════════════════
  private async getRunningBuilds() {
    const r = await this.http.get('/api/json', {
      params: { tree: 'jobs[name,url,lastBuild[number,building,timestamp,url]]' },
    });
    const running = (r.data.jobs || [])
      .filter((j: any) => j.lastBuild?.building)
      .map((j: any) => ({
        name: j.name, jobUrl: j.url, buildNumber: j.lastBuild.number, buildUrl: j.lastBuild.url,
        startedAt: new Date(j.lastBuild.timestamp).toISOString(),
        runningForSeconds: Math.floor((Date.now() - j.lastBuild.timestamp) / 1000),
      }));
    return this.json({ count: running.length, runningBuilds: running });
  }

  private async getQueueItems() {
    const r = await this.http.get('/queue/api/json', {
      params: { tree: 'items[id,inQueueSince,why,blocked,stuck,task[name,url],actions[parameters[name,value]]]' },
    });
    const items = (r.data.items || []).map((item: any) => ({
      id: item.id, jobName: item.task?.name, jobUrl: item.task?.url,
      inQueueSince: new Date(item.inQueueSince).toISOString(),
      waitingForSeconds: Math.floor((Date.now() - item.inQueueSince) / 1000),
      blocked: item.blocked, stuck: item.stuck, reason: item.why,
      parameters: (item.actions || []).flatMap((a: any) => a.parameters || [])
        .reduce((acc: any, p: any) => { acc[p.name] = p.value; return acc; }, {}),
    }));
    return this.json({ count: items.length, queueItems: items });
  }

  /** NEW: cancel a queue item */
  private async cancelQueueItem(a: any) {
    if (!a?.itemId) throw new McpError(ErrorCode.InvalidParams, 'itemId is required');
    await this.post(`/queue/cancelItem?id=${a.itemId}`);
    return this.ok(`Queue item ${a.itemId} cancelled.`);
  }

  private async getBuildHistory(a: any) {
    if (!a?.jobPath) throw new McpError(ErrorCode.InvalidParams, 'jobPath is required');
    const limit = a.limit ?? 10;
    const r = await this.http.get(`/${a.jobPath}/api/json`, {
      params: { tree: `builds[number,result,duration,timestamp,url]{0,${limit}}` },
    });
    const builds = (r.data.builds || []).map((b: any) => ({
      number: b.number, result: b.result ?? (b.duration === 0 ? 'RUNNING' : 'UNKNOWN'),
      durationSeconds: Math.floor(b.duration / 1000),
      startedAt: new Date(b.timestamp).toISOString(), url: b.url,
    }));
    const completed = builds.filter((b: any) => b.result !== 'RUNNING');
    const passed = completed.filter((b: any) => b.result === 'SUCCESS').length;
    const stability = completed.length ? `${Math.round((passed / completed.length) * 100)}%` : 'n/a';
    return this.json({ jobPath: a.jobPath, stability, builds });
  }

  private async getBuildChanges(a: any) {
    if (!a?.jobPath) throw new McpError(ErrorCode.InvalidParams, 'jobPath is required');
    const num = a.buildNumber || 'lastBuild';
    const r = await this.http.get(`/${a.jobPath}/${num}/api/json`, {
      params: { tree: 'number,result,changeSets[items[commitId,msg,author[fullName],timestamp,affectedPaths]]' },
    });
    const commits = (r.data.changeSets || []).flatMap((cs: any) =>
      (cs.items || []).map((item: any) => ({
        commitId: item.commitId, author: item.author?.fullName ?? 'unknown',
        message: item.msg, filesChanged: (item.affectedPaths || []).length,
        timestamp: item.timestamp ? new Date(item.timestamp).toISOString() : null,
      }))
    );
    return this.json({ jobPath: a.jobPath, buildNumber: r.data.number, result: r.data.result, totalCommits: commits.length, commits });
  }

  /** NEW: list build artifacts */
  private async getBuildArtifacts(a: any) {
    if (!a?.jobPath) throw new McpError(ErrorCode.InvalidParams, 'jobPath is required');
    const num = a.buildNumber || 'lastBuild';
    const r = await this.http.get(`/${a.jobPath}/${num}/api/json`, {
      params: { tree: 'number,artifacts[displayPath,relativePath,fileName]' },
    });
    const artifacts = (r.data.artifacts || []).map((art: any) => ({
      fileName: art.fileName, displayPath: art.displayPath,
      downloadUrl: `${JENKINS_URL}/${a.jobPath}/${r.data.number}/artifact/${art.relativePath}`,
    }));
    return this.json({ jobPath: a.jobPath, buildNumber: r.data.number, count: artifacts.length, artifacts });
  }

  /** NEW: build timing detail */
  private async getBuildTimings(a: any) {
    if (!a?.jobPath) throw new McpError(ErrorCode.InvalidParams, 'jobPath is required');
    const num = a.buildNumber || 'lastBuild';
    const r = await this.http.get(`/${a.jobPath}/${num}/api/json`, {
      params: { tree: 'number,building,timestamp,duration,estimatedDuration,result' },
    });
    const d = r.data;
    const elapsed = d.building ? Date.now() - d.timestamp : d.duration;
    return this.json({
      buildNumber: d.number, building: d.building, result: d.result,
      startedAt: new Date(d.timestamp).toISOString(),
      elapsedSeconds: Math.floor(elapsed / 1000),
      estimatedTotalSeconds: Math.floor(d.estimatedDuration / 1000),
      remainingSeconds: d.building ? Math.max(0, Math.floor((d.estimatedDuration - elapsed) / 1000)) : null,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST & QUALITY
  // ═══════════════════════════════════════════════════════════════════════════
  private async getTestResults(a: any) {
    if (!a?.jobPath) throw new McpError(ErrorCode.InvalidParams, 'jobPath is required');
    const num = a.buildNumber || 'lastBuild';
    let report: any;
    try {
      const r = await this.http.get(`/${a.jobPath}/${num}/testReport/api/json`, {
        params: { tree: 'failCount,passCount,skipCount,suites[cases[className,name,status,duration]]' },
      });
      report = r.data;
    } catch (err: any) {
      if (err?.response?.status === 404)
        return this.ok(`No test report found for build "${num}" of "${a.jobPath}".`);
      throw err;
    }
    const failedTests = (report.suites || [])
      .flatMap((s: any) => s.cases || [])
      .filter((c: any) => ['FAILED','REGRESSION'].includes(c.status))
      .map((c: any) => ({ class: c.className, test: c.name, durationSeconds: c.duration }));
    return this.json({
      jobPath: a.jobPath, buildNumber: num,
      summary: {
        passed: report.passCount, failed: report.failCount, skipped: report.skipCount,
        total: (report.passCount ?? 0) + (report.failCount ?? 0) + (report.skipCount ?? 0),
      },
      failedTests,
    });
  }

  /** NEW: identify flaky tests across last N builds */
  private async getFlakyTests(a: any) {
    if (!a?.jobPath) throw new McpError(ErrorCode.InvalidParams, 'jobPath is required');
    const limit = a.limit ?? 10;
    // Collect build numbers
    const histResp = await this.http.get(`/${a.jobPath}/api/json`, {
      params: { tree: `builds[number,result]{0,${limit}}` },
    });
    const builds: number[] = (histResp.data.builds || [])
      .filter((b: any) => b.result && b.result !== 'ABORTED')
      .map((b: any) => b.number);

    // Per-test result map: testKey → array of 'PASS'|'FAIL'
    const testHistory: Record<string, string[]> = {};
    await Promise.all(builds.map(async (num) => {
      try {
        const r = await this.http.get(`/${a.jobPath}/${num}/testReport/api/json`, {
          params: { tree: 'suites[cases[className,name,status]]' },
        });
        for (const suite of r.data.suites || []) {
          for (const c of suite.cases || []) {
            const key = `${c.className}#${c.name}`;
            if (!testHistory[key]) testHistory[key] = [];
            testHistory[key].push(['FAILED','REGRESSION'].includes(c.status) ? 'FAIL' : 'PASS');
          }
        }
      } catch { /* no test report for this build — skip */ }
    }));

    const flaky = Object.entries(testHistory)
      .filter(([, results]) => results.includes('PASS') && results.includes('FAIL'))
      .map(([key, results]) => {
        const [className, testName] = key.split('#');
        const failRate = Math.round((results.filter(r => r === 'FAIL').length / results.length) * 100);
        return { className, testName, failRate: `${failRate}%`, history: results };
      })
      .sort((x, y) => parseInt(y.failRate) - parseInt(x.failRate));

    return this.json({ jobPath: a.jobPath, buildsAnalysed: builds.length, flakyTestCount: flaky.length, flakyTests: flaky });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NODES / INFRASTRUCTURE
  // ═══════════════════════════════════════════════════════════════════════════
  private async getNodes() {
    const r = await this.http.get('/computer/api/json', {
      params: { tree: 'computer[displayName,description,offline,temporarilyOffline,numExecutors,idle,assignedLabels[name]]' },
    });
    const nodes = (r.data.computer || []).map((n: any) => ({
      name: n.displayName, description: n.description || null,
      status: n.offline ? (n.temporarilyOffline ? 'temporarily-offline' : 'offline') : 'online',
      idle: n.idle, numExecutors: n.numExecutors,
      labels: (n.assignedLabels || []).map((l: any) => l.name).filter(Boolean),
    }));
    const online = nodes.filter((n: any) => n.status === 'online').length;
    return this.json({ summary: { total: nodes.length, online, offline: nodes.length - online }, nodes });
  }

  /** NEW: take a node online / mark it offline */
  private async toggleNode(a: any) {
    if (!a?.nodeName || !a?.action)
      throw new McpError(ErrorCode.InvalidParams, 'nodeName and action are required');
    const crumb = await this.getCrumb();
    const encoded = encodeURIComponent(a.nodeName);
    if (a.action === 'offline') {
      const params = new URLSearchParams({ offlineMessage: a.reason || '' });
      await this.http.post(`/computer/${encoded}/toggleOffline?offlineMessage=${encodeURIComponent(a.reason || '')}`, {}, { headers: crumb });
    } else {
      await this.http.post(`/computer/${encoded}/toggleOffline`, {}, { headers: crumb });
    }
    return this.ok(`Node "${a.nodeName}" set to ${a.action}.`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SERVER HEALTH
  // ═══════════════════════════════════════════════════════════════════════════

  /** NEW: server overview */
  private async getServerInfo() {
    const r = await this.http.get('/api/json', {
      params: { tree: 'quietingDown,useSecurity,numExecutors,jobs[_class]' },
    });
    const versionHeader = (await this.http.get('/')).headers['x-jenkins'];
    return this.json({
      jenkinsVersion: versionHeader ?? 'unknown',
      quietingDown: r.data.quietingDown,
      useSecurity: r.data.useSecurity,
      totalExecutors: r.data.numExecutors,
      topLevelJobCount: (r.data.jobs || []).length,
    });
  }

  /** NEW: quiet-down / cancel quiet-down */
  private async quietDown(a: any) {
    if (!['start','cancel'].includes(a?.action))
      throw new McpError(ErrorCode.InvalidParams, 'action must be "start" or "cancel"');
    const endpoint = a.action === 'start' ? '/quietDown' : '/cancelQuietDown';
    await this.post(endpoint);
    return this.ok(`Quiet-down ${a.action === 'start' ? 'initiated' : 'cancelled'}.`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // USERS
  // ═══════════════════════════════════════════════════════════════════════════
  private async createJenkinsUser(a: any) {
    const { username, password, fullName, email } = a || {};
    if (!username || !password) throw new McpError(ErrorCode.InvalidParams, 'username and password are required');
    const crumb = await this.getCrumb();
    const params = new URLSearchParams({ username, password1: password, password2: password });
    if (fullName) params.append('fullname', fullName);
    if (email)    params.append('email', email);
    await this.http.post('/securityRealm/createAccountByAdmin', params, {
      headers: { ...crumb, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    return this.ok(`User "${username}" created successfully.`);
  }

  /** NEW: list all users */
  private async listUsers() {
    const r = await this.http.get('/asynchPeople/api/json', {
      params: { tree: 'users[user[id,fullName],lastChange]' },
    });
    const users = (r.data.users || []).map((u: any) => ({
      id: u.user?.id, fullName: u.user?.fullName,
      lastChange: u.lastChange ? new Date(u.lastChange).toISOString() : null,
    }));
    return this.json({ count: users.length, users });
  }

  // ─── Bootstrap ─────────────────────────────────────────────────────────────
  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Jenkins MCP server v0.3.0 running on stdio');
  }
}

const server = new JenkinsServer();
server.run().catch(console.error);
