#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';

const JENKINS_URL = process.env.JENKINS_URL || '';
const JENKINS_USER = process.env.JENKINS_USER || '';
const JENKINS_TOKEN = process.env.JENKINS_TOKEN || '';

interface BuildStatus {
  building: boolean;
  result: string | null;
  timestamp: number;
  duration: number;
  url: string;
}

interface FlatJob {
  name: string;
  fullPath: string;
  url: string;
  lastBuild: {
    number: number;
    result: string;
    url: string;
  } | null;
  isFolder: boolean;
}

class JenkinsServer {
  private server: Server;
  private axiosInstance: any;

  constructor() {
    this.server = new Server(
      {
        name: 'jenkins-server',
        version: '0.2.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.axiosInstance = axios.create({
      baseURL: JENKINS_URL,
      auth: {
        username: JENKINS_USER,
        password: JENKINS_TOKEN,
      },
    });

    this.setupToolHandlers();

    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  // ─── Helper: Convert "FolderA/SubFolder/Job" → "job/FolderA/job/SubFolder/job/Job" ───
  private toJenkinsPath(path: string): string {
    return path
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => `job/${encodeURIComponent(s)}`)
      .join('/');
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        // ── Existing tools ────────────────────────────────────────────────────
        {
          name: 'get_build_status',
          description: 'Get the status of a Jenkins build',
          inputSchema: {
            type: 'object',
            properties: {
              jobPath: {
                type: 'string',
                description: 'Path to the Jenkins job (e.g., "view/xxx_debug")',
              },
              buildNumber: {
                type: 'string',
                description: 'Build number (use "lastBuild" for most recent)',
              },
            },
            required: ['jobPath'],
          },
        },
        {
          name: 'list_all_jobs',
          description: 'List all Jenkins jobs with their name, URL, and last build status.',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
        {
          name: 'list_folder_jobs',
          description:
            'List all jobs inside a Jenkins folder, including nested sub-folders up to 4 levels deep.',
          inputSchema: {
            type: 'object',
            properties: {
              folderPath: {
                type: 'string',
                description: 'Folder name or slash-separated nested path. E.g. "CS" or "CS/PP"',
              },
            },
            required: ['folderPath'],
          },
        },
        {
          name: 'list_recent_failed_jobs',
          description:
            'List Jenkins jobs whose most recent build failed, sorted by most recent failure time.',
          inputSchema: {
            type: 'object',
            properties: {
              limit: { type: 'number', description: 'Max failed jobs to return', default: 10 },
            },
            required: [],
          },
        },
        {
          name: 'count_failed_jobs',
          description: 'Count how many Jenkins jobs currently have their last build in FAILURE state.',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
        {
          name: 'get_failed_build_log',
          description: 'Get the console output of the last failed build for a given Jenkins job.',
          inputSchema: {
            type: 'object',
            properties: {
              jobPath: { type: 'string', description: 'Path to the Jenkins job' },
            },
            required: ['jobPath'],
          },
        },
        {
          name: 'create_jenkins_user',
          description: 'Create a new Jenkins user in the internal user database. Requires admin permissions.',
          inputSchema: {
            type: 'object',
            properties: {
              username: { type: 'string' },
              password: { type: 'string' },
              fullName: { type: 'string' },
              email: { type: 'string' },
            },
            required: ['username', 'password'],
          },
        },
        {
          name: 'trigger_build',
          description: 'Trigger a new Jenkins build',
          inputSchema: {
            type: 'object',
            properties: {
              jobPath: { type: 'string', description: 'Path to the Jenkins job' },
              parameters: {
                type: 'object',
                description: 'Build parameters (optional)',
                additionalProperties: true,
              },
            },
            required: ['jobPath', 'parameters'],
          },
        },
        {
          name: 'get_build_log',
          description: 'Get the console output of a Jenkins build',
          inputSchema: {
            type: 'object',
            properties: {
              jobPath: { type: 'string' },
              buildNumber: { type: 'string', description: 'Build number or "lastBuild"' },
            },
            required: ['jobPath', 'buildNumber'],
          },
        },

        // ── NEW: Build Control ────────────────────────────────────────────────
        {
          name: 'abort_build',
          description: 'Abort a currently running Jenkins build. Use buildNumber "lastBuild" to stop the most recent.',
          inputSchema: {
            type: 'object',
            properties: {
              jobPath: { type: 'string', description: 'Path to the Jenkins job' },
              buildNumber: {
                type: 'string',
                description: 'Build number to abort, or "lastBuild" for the current one',
                default: 'lastBuild',
              },
            },
            required: ['jobPath'],
          },
        },
        {
          name: 'retry_failed_build',
          description:
            'Re-trigger the last failed build of a job using the same parameters. Saves you from looking up build info manually.',
          inputSchema: {
            type: 'object',
            properties: {
              jobPath: { type: 'string', description: 'Path to the Jenkins job' },
            },
            required: ['jobPath'],
          },
        },
        {
          name: 'bulk_trigger',
          description:
            'Trigger multiple Jenkins jobs in a single call. Useful for deploying a stack of services at once.',
          inputSchema: {
            type: 'object',
            properties: {
              jobs: {
                type: 'array',
                description: 'Array of jobs to trigger',
                items: {
                  type: 'object',
                  properties: {
                    jobPath: { type: 'string' },
                    parameters: { type: 'object', additionalProperties: true },
                  },
                  required: ['jobPath'],
                },
              },
            },
            required: ['jobs'],
          },
        },

        // ── NEW: Visibility & Monitoring ──────────────────────────────────────
        {
          name: 'get_running_builds',
          description:
            'List all jobs that are currently building across the entire Jenkins server.',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
        {
          name: 'get_queue_items',
          description:
            'Show all builds waiting in the Jenkins queue (e.g. stuck waiting for an available agent).',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
        {
          name: 'get_build_history',
          description:
            'Get the last N builds for a specific job with result, duration, and timestamp — useful for spotting flaky jobs.',
          inputSchema: {
            type: 'object',
            properties: {
              jobPath: { type: 'string', description: 'Path to the Jenkins job' },
              limit: { type: 'number', description: 'Number of builds to return (default 10)', default: 10 },
            },
            required: ['jobPath'],
          },
        },
        {
          name: 'get_build_changes',
          description:
            'Show the Git commits / SCM changes included in a specific build. Useful for tracing what code went into a deployment.',
          inputSchema: {
            type: 'object',
            properties: {
              jobPath: { type: 'string', description: 'Path to the Jenkins job' },
              buildNumber: { type: 'string', description: 'Build number or "lastBuild"', default: 'lastBuild' },
            },
            required: ['jobPath'],
          },
        },

        // ── NEW: Test & Quality ───────────────────────────────────────────────
        {
          name: 'get_test_results',
          description:
            'Fetch pass/fail/skip counts and the names of failed tests from a build\'s test report.',
          inputSchema: {
            type: 'object',
            properties: {
              jobPath: { type: 'string', description: 'Path to the Jenkins job' },
              buildNumber: { type: 'string', description: 'Build number or "lastBuild"', default: 'lastBuild' },
            },
            required: ['jobPath'],
          },
        },

        // ── NEW: Infrastructure ───────────────────────────────────────────────
        {
          name: 'get_nodes',
          description:
            'List all Jenkins agents/nodes with their online/offline status, number of executors, and assigned labels.',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
        {
          name: 'toggle_job',
          description:
            'Enable or disable a Jenkins job without using the UI. Useful for suppressing noisy or broken jobs temporarily.',
          inputSchema: {
            type: 'object',
            properties: {
              jobPath: { type: 'string', description: 'Path to the Jenkins job' },
              action: {
                type: 'string',
                enum: ['enable', 'disable'],
                description: '"enable" or "disable"',
              },
            },
            required: ['jobPath', 'action'],
          },
        },

        // ── NEW: Discovery ────────────────────────────────────────────────────
        {
          name: 'search_jobs',
          description:
            'Search for jobs by name across all top-level jobs and folders. Supports substring and case-insensitive matching.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Substring to search for in job names' },
              caseSensitive: {
                type: 'boolean',
                description: 'Whether the search is case-sensitive (default false)',
                default: false,
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'get_job_parameters',
          description:
            'Inspect what parameters a job accepts before triggering it, including their names, types, and default values.',
          inputSchema: {
            type: 'object',
            properties: {
              jobPath: { type: 'string', description: 'Path to the Jenkins job' },
            },
            required: ['jobPath'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        switch (request.params.name) {
          // Existing
          case 'get_build_status':      return await this.getBuildStatus(request.params.arguments);
          case 'trigger_build':         return await this.triggerBuild(request.params.arguments);
          case 'get_build_log':         return await this.getBuildLog(request.params.arguments);
          case 'list_recent_failed_jobs': return await this.listRecentFailedJobs(request.params.arguments);
          case 'list_all_jobs':         return await this.listAllJobs();
          case 'list_folder_jobs':      return await this.listFolderJobs(request.params.arguments);
          case 'count_failed_jobs':     return await this.countFailedJobs();
          case 'get_failed_build_log':  return await this.getFailedBuildLog(request.params.arguments);
          case 'create_jenkins_user':   return await this.createJenkinsUser(request.params.arguments);
          // New — Build Control
          case 'abort_build':           return await this.abortBuild(request.params.arguments);
          case 'retry_failed_build':    return await this.retryFailedBuild(request.params.arguments);
          case 'bulk_trigger':          return await this.bulkTrigger(request.params.arguments);
          // New — Visibility & Monitoring
          case 'get_running_builds':    return await this.getRunningBuilds();
          case 'get_queue_items':       return await this.getQueueItems();
          case 'get_build_history':     return await this.getBuildHistory(request.params.arguments);
          case 'get_build_changes':     return await this.getBuildChanges(request.params.arguments);
          // New — Test & Quality
          case 'get_test_results':      return await this.getTestResults(request.params.arguments);
          // New — Infrastructure
          case 'get_nodes':             return await this.getNodes();
          case 'toggle_job':            return await this.toggleJob(request.params.arguments);
          // New — Discovery
          case 'search_jobs':           return await this.searchJobs(request.params.arguments);
          case 'get_job_parameters':    return await this.getJobParameters(request.params.arguments);

          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        }
      } catch (error: any) {
        if (error instanceof McpError) throw error;
        if (axios.isAxiosError(error)) {
          throw new McpError(
            ErrorCode.InternalError,
            `Jenkins API error: ${error.response?.data?.message || error.message}`
          );
        }
        throw new McpError(ErrorCode.InternalError, 'Unknown error occurred');
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXISTING TOOLS (unchanged)
  // ═══════════════════════════════════════════════════════════════════════════

  private async getBuildStatus(args: any) {
    const buildNumber = args.buildNumber || 'lastBuild';
    const response = await this.axiosInstance.get(`/${args.jobPath}/${buildNumber}/api/json`);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          building: response.data.building,
          result: response.data.result,
          timestamp: response.data.timestamp,
          duration: response.data.duration,
          url: response.data.url,
        }, null, 2),
      }],
    };
  }

  private async triggerBuild(args: any) {
    const { jobPath, parameters } = args;
    const crumbResp = await this.axiosInstance.get('/crumbIssuer/api/json');
    const crumbField = crumbResp.data.crumbRequestField;
    const crumbValue = crumbResp.data.crumb;

    if (!parameters || Object.keys(parameters).length === 0) {
      await this.axiosInstance.post(`/${jobPath}/build`, {}, {
        headers: { [crumbField]: crumbValue },
      });
      return { content: [{ type: 'text', text: 'Job triggered successfully using /build' }] };
    }

    const body = new URLSearchParams();
    Object.entries(parameters).forEach(([key, value]) => body.append(key, String(value)));
    await this.axiosInstance.post(`/${jobPath}/buildWithParameters`, body, {
      headers: { [crumbField]: crumbValue, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    return { content: [{ type: 'text', text: 'Parameterized job triggered successfully using /buildWithParameters' }] };
  }

  private async getBuildLog(args: any) {
    const response = await this.axiosInstance.get(`/${args.jobPath}/${args.buildNumber}/consoleText`);
    return { content: [{ type: 'text', text: response.data }] };
  }

  private async listRecentFailedJobs(args: any) {
    const limit = args?.limit ?? 10;
    const response = await this.axiosInstance.get('/api/json', {
      params: { tree: 'jobs[name,url,lastBuild[number,result,timestamp,url]]' },
    });
    const failedJobs = (response.data.jobs || [])
      .filter((job: any) => job.lastBuild?.result === 'FAILURE' && typeof job.lastBuild.timestamp === 'number')
      .sort((a: any, b: any) => b.lastBuild.timestamp - a.lastBuild.timestamp)
      .slice(0, limit)
      .map((job: any) => ({
        name: job.name,
        jobUrl: job.url,
        buildNumber: job.lastBuild.number,
        result: job.lastBuild.result,
        timestamp: job.lastBuild.timestamp,
        buildUrl: job.lastBuild.url,
      }));
    return { content: [{ type: 'text', text: JSON.stringify({ count: failedJobs.length, failedJobs }, null, 2) }] };
  }

  private async listAllJobs() {
    const response = await this.axiosInstance.get('/api/json', {
      params: { tree: 'jobs[name,url,color,lastBuild[number,result,url]]' },
    });
    const jobs = (response.data.jobs || []).map((job: any) => ({
      name: job.name,
      url: job.url,
      lastBuild: job.lastBuild ? { number: job.lastBuild.number, result: job.lastBuild.result, url: job.lastBuild.url } : null,
      statusColor: job.color,
    }));
    return { content: [{ type: 'text', text: JSON.stringify({ count: jobs.length, jobs }, null, 2) }] };
  }

  private async listFolderJobs(args: any) {
    const folderPath: string = args?.folderPath ?? '';
    if (!folderPath.trim()) throw new McpError(ErrorCode.InvalidParams, 'folderPath is required.');

    const apiPath = this.toJenkinsPath(folderPath);
    const tree =
      'jobs[name,url,color,lastBuild[number,result,url],' +
        'jobs[name,url,color,lastBuild[number,result,url],' +
          'jobs[name,url,color,lastBuild[number,result,url],' +
            'jobs[name,url,color,lastBuild[number,result,url]]]]]';

    const response = await this.axiosInstance.get(`/${apiPath}/api/json`, { params: { tree } });
    const flatJobs: FlatJob[] = [];

    const flatten = (jobs: any[], parentPath: string): void => {
      for (const job of jobs) {
        const fullPath = parentPath ? `${parentPath}/${job.name}` : job.name;
        const isFolder = Array.isArray(job.jobs);
        flatJobs.push({
          name: job.name, fullPath, url: job.url,
          lastBuild: job.lastBuild ? { number: job.lastBuild.number, result: job.lastBuild.result, url: job.lastBuild.url } : null,
          isFolder,
        });
        if (isFolder && job.jobs.length > 0) flatten(job.jobs, fullPath);
      }
    };

    flatten(response.data.jobs || [], folderPath);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          folderPath, totalItems: flatJobs.length,
          jobCount: flatJobs.filter((j) => !j.isFolder).length,
          folderCount: flatJobs.filter((j) => j.isFolder).length,
          jobs: flatJobs,
        }, null, 2),
      }],
    };
  }

  private async countFailedJobs() {
    const response = await this.axiosInstance.get('/api/json', {
      params: { tree: 'jobs[name,lastBuild[result]]' },
    });
    const failedCount = (response.data.jobs || []).filter((job: any) => job.lastBuild?.result === 'FAILURE').length;
    return { content: [{ type: 'text', text: JSON.stringify({ failedJobCount: failedCount }, null, 2) }] };
  }

  private async getFailedBuildLog(args: any) {
    if (!args?.jobPath) throw new McpError(ErrorCode.InvalidParams, 'jobPath is required');
    const jobInfo = await this.axiosInstance.get(`/${args.jobPath}/api/json`, {
      params: { tree: 'name,url,lastFailedBuild[number,url]' },
    });
    const lastFailedBuild = jobInfo.data.lastFailedBuild;
    if (!lastFailedBuild?.number) {
      return { content: [{ type: 'text', text: `Job "${jobInfo.data.name}" has no failed builds.` }] };
    }
    const logResponse = await this.axiosInstance.get(`/${args.jobPath}/${lastFailedBuild.number}/consoleText`);
    return { content: [{ type: 'text', text: logResponse.data }] };
  }

  private async createJenkinsUser(args: any) {
    const { username, password, fullName, email } = args || {};
    if (!username || !password) throw new McpError(ErrorCode.InvalidParams, 'username and password are required');

    const crumbResp = await this.axiosInstance.get('/crumbIssuer/api/json');
    const params = new URLSearchParams();
    params.append('username', username);
    params.append('password1', password);
    params.append('password2', password);
    if (fullName) params.append('fullname', fullName);
    if (email) params.append('email', email);

    await this.axiosInstance.post('/securityRealm/createAccountByAdmin', params, {
      headers: {
        [crumbResp.data.crumbRequestField]: crumbResp.data.crumb,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    return { content: [{ type: 'text', text: `User "${username}" created successfully.` }] };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NEW: BUILD CONTROL
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * abort_build
   * Stops a running build by POSTing to /{jobPath}/{buildNumber}/stop.
   * Defaults to "lastBuild" if no build number is provided.
   */
  private async abortBuild(args: any) {
    if (!args?.jobPath) throw new McpError(ErrorCode.InvalidParams, 'jobPath is required');
    const buildNumber = args.buildNumber || 'lastBuild';

    const crumbResp = await this.axiosInstance.get('/crumbIssuer/api/json');

    // First verify the build is actually running
    const statusResp = await this.axiosInstance.get(`/${args.jobPath}/${buildNumber}/api/json`);
    if (!statusResp.data.building) {
      return {
        content: [{
          type: 'text',
          text: `Build #${statusResp.data.number} is not currently running (result: ${statusResp.data.result ?? 'unknown'}).`,
        }],
      };
    }

    await this.axiosInstance.post(
      `/${args.jobPath}/${statusResp.data.number}/stop`,
      {},
      { headers: { [crumbResp.data.crumbRequestField]: crumbResp.data.crumb } }
    );

    return {
      content: [{
        type: 'text',
        text: `Build #${statusResp.data.number} of "${args.jobPath}" has been aborted.`,
      }],
    };
  }

  /**
   * retry_failed_build
   * Looks up the last failed build's parameters and re-triggers the job with
   * the same parameter values, so you don't have to look anything up manually.
   */
  private async retryFailedBuild(args: any) {
    if (!args?.jobPath) throw new McpError(ErrorCode.InvalidParams, 'jobPath is required');

    // Get last failed build number
    const jobInfo = await this.axiosInstance.get(`/${args.jobPath}/api/json`, {
      params: { tree: 'lastFailedBuild[number,actions[parameters[name,value]]]' },
    });

    const lastFailed = jobInfo.data.lastFailedBuild;
    if (!lastFailed?.number) {
      return { content: [{ type: 'text', text: `No failed builds found for "${args.jobPath}".` }] };
    }

    // Extract parameters from the failed build's actions
    const parameters: Record<string, string> = {};
    for (const action of lastFailed.actions || []) {
      for (const param of action.parameters || []) {
        parameters[param.name] = param.value;
      }
    }

    // Re-trigger
    const crumbResp = await this.axiosInstance.get('/crumbIssuer/api/json');
    const hasParams = Object.keys(parameters).length > 0;

    if (hasParams) {
      const body = new URLSearchParams();
      Object.entries(parameters).forEach(([k, v]) => body.append(k, String(v)));
      await this.axiosInstance.post(`/${args.jobPath}/buildWithParameters`, body, {
        headers: {
          [crumbResp.data.crumbRequestField]: crumbResp.data.crumb,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });
    } else {
      await this.axiosInstance.post(`/${args.jobPath}/build`, {}, {
        headers: { [crumbResp.data.crumbRequestField]: crumbResp.data.crumb },
      });
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          message: `Retried failed build #${lastFailed.number} of "${args.jobPath}".`,
          parametersUsed: hasParams ? parameters : '(none)',
        }, null, 2),
      }],
    };
  }

  /**
   * bulk_trigger
   * Triggers multiple jobs in sequence. Returns a per-job success/failure summary.
   */
  private async bulkTrigger(args: any) {
    if (!Array.isArray(args?.jobs) || args.jobs.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'jobs array is required and must not be empty');
    }

    const crumbResp = await this.axiosInstance.get('/crumbIssuer/api/json');
    const crumbHeader = { [crumbResp.data.crumbRequestField]: crumbResp.data.crumb };
    const results: Array<{ jobPath: string; status: string; error?: string }> = [];

    for (const job of args.jobs) {
      try {
        const { jobPath, parameters } = job;
        const hasParams = parameters && Object.keys(parameters).length > 0;

        if (hasParams) {
          const body = new URLSearchParams();
          Object.entries(parameters).forEach(([k, v]) => body.append(k, String(v)));
          await this.axiosInstance.post(`/${jobPath}/buildWithParameters`, body, {
            headers: { ...crumbHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
          });
        } else {
          await this.axiosInstance.post(`/${jobPath}/build`, {}, { headers: crumbHeader });
        }

        results.push({ jobPath, status: 'triggered' });
      } catch (err: any) {
        results.push({
          jobPath: job.jobPath,
          status: 'failed',
          error: err?.response?.data?.message || err?.message || 'Unknown error',
        });
      }
    }

    const succeeded = results.filter((r) => r.status === 'triggered').length;
    const failed = results.filter((r) => r.status === 'failed').length;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ summary: { total: results.length, succeeded, failed }, results }, null, 2),
      }],
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NEW: VISIBILITY & MONITORING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * get_running_builds
   * Returns all jobs that currently have a build in progress.
   */
  private async getRunningBuilds() {
    const response = await this.axiosInstance.get('/api/json', {
      params: {
        tree: 'jobs[name,url,lastBuild[number,building,timestamp,url,executor[currentExecutable[url]]]]',
      },
    });

    const running = (response.data.jobs || [])
      .filter((job: any) => job.lastBuild?.building === true)
      .map((job: any) => ({
        name: job.name,
        jobUrl: job.url,
        buildNumber: job.lastBuild.number,
        buildUrl: job.lastBuild.url,
        startedAt: new Date(job.lastBuild.timestamp).toISOString(),
        runningForSeconds: Math.floor((Date.now() - job.lastBuild.timestamp) / 1000),
      }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ count: running.length, runningBuilds: running }, null, 2),
      }],
    };
  }

  /**
   * get_queue_items
   * Returns all items currently waiting in the Jenkins build queue.
   */
  private async getQueueItems() {
    const response = await this.axiosInstance.get('/queue/api/json', {
      params: {
        tree: 'items[id,inQueueSince,why,blocked,stuck,task[name,url],actions[parameters[name,value]]]',
      },
    });

    const items = (response.data.items || []).map((item: any) => ({
      id: item.id,
      jobName: item.task?.name,
      jobUrl: item.task?.url,
      inQueueSince: new Date(item.inQueueSince).toISOString(),
      waitingForSeconds: Math.floor((Date.now() - item.inQueueSince) / 1000),
      blocked: item.blocked,
      stuck: item.stuck,
      reason: item.why,
      parameters: (item.actions || []).flatMap((a: any) => a.parameters || []).reduce(
        (acc: any, p: any) => { acc[p.name] = p.value; return acc; }, {}
      ),
    }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ count: items.length, queueItems: items }, null, 2),
      }],
    };
  }

  /**
   * get_build_history
   * Returns the last N builds for a job including result, duration, and timestamp.
   */
  private async getBuildHistory(args: any) {
    if (!args?.jobPath) throw new McpError(ErrorCode.InvalidParams, 'jobPath is required');
    const limit = args.limit ?? 10;

    const response = await this.axiosInstance.get(`/${args.jobPath}/api/json`, {
      params: {
        tree: `builds[number,result,duration,timestamp,url]{0,${limit}}`,
      },
    });

    const builds = (response.data.builds || []).map((b: any) => ({
      number: b.number,
      result: b.result ?? (b.duration === 0 ? 'RUNNING' : 'UNKNOWN'),
      durationSeconds: Math.floor(b.duration / 1000),
      startedAt: new Date(b.timestamp).toISOString(),
      url: b.url,
    }));

    // Derive a simple stability score: % of non-running builds that passed
    const completed = builds.filter((b: any) => b.result !== 'RUNNING');
    const passed = completed.filter((b: any) => b.result === 'SUCCESS').length;
    const stabilityPct = completed.length > 0 ? Math.round((passed / completed.length) * 100) : null;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          jobPath: args.jobPath,
          stability: stabilityPct !== null ? `${stabilityPct}%` : 'n/a',
          builds,
        }, null, 2),
      }],
    };
  }

  /**
   * get_build_changes
   * Returns the SCM changesets (commits) included in a specific build.
   */
  private async getBuildChanges(args: any) {
    if (!args?.jobPath) throw new McpError(ErrorCode.InvalidParams, 'jobPath is required');
    const buildNumber = args.buildNumber || 'lastBuild';

    const response = await this.axiosInstance.get(`/${args.jobPath}/${buildNumber}/api/json`, {
      params: {
        tree: 'number,result,changeSets[items[commitId,msg,author[fullName],timestamp,affectedPaths]]',
      },
    });

    const changeSets = response.data.changeSets || [];
    const commits = changeSets.flatMap((cs: any) =>
      (cs.items || []).map((item: any) => ({
        commitId: item.commitId,
        author: item.author?.fullName ?? 'unknown',
        message: item.msg,
        timestamp: item.timestamp ? new Date(item.timestamp).toISOString() : null,
        filesChanged: (item.affectedPaths || []).length,
      }))
    );

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          jobPath: args.jobPath,
          buildNumber: response.data.number,
          result: response.data.result,
          totalCommits: commits.length,
          commits,
        }, null, 2),
      }],
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NEW: TEST & QUALITY
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * get_test_results
   * Fetches the JUnit/test report from a build: pass/fail/skip counts + failed test names.
   */
  private async getTestResults(args: any) {
    if (!args?.jobPath) throw new McpError(ErrorCode.InvalidParams, 'jobPath is required');
    const buildNumber = args.buildNumber || 'lastBuild';

    let report: any;
    try {
      const response = await this.axiosInstance.get(
        `/${args.jobPath}/${buildNumber}/testReport/api/json`,
        {
          params: {
            tree: 'failCount,passCount,skipCount,suites[cases[className,name,status,duration]]',
          },
        }
      );
      report = response.data;
    } catch (err: any) {
      if (err?.response?.status === 404) {
        return {
          content: [{
            type: 'text',
            text: `No test report found for build "${buildNumber}" of "${args.jobPath}". The job may not publish test results.`,
          }],
        };
      }
      throw err;
    }

    const failedTests = (report.suites || [])
      .flatMap((suite: any) => suite.cases || [])
      .filter((c: any) => c.status === 'FAILED' || c.status === 'REGRESSION')
      .map((c: any) => ({
        class: c.className,
        test: c.name,
        durationSeconds: c.duration,
      }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          jobPath: args.jobPath,
          buildNumber,
          summary: {
            passed: report.passCount,
            failed: report.failCount,
            skipped: report.skipCount,
            total: (report.passCount ?? 0) + (report.failCount ?? 0) + (report.skipCount ?? 0),
          },
          failedTests,
        }, null, 2),
      }],
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NEW: INFRASTRUCTURE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * get_nodes
   * Returns all Jenkins agents/nodes with status, executor count, and labels.
   */
  private async getNodes() {
    const response = await this.axiosInstance.get('/computer/api/json', {
      params: {
        tree: 'computer[displayName,description,offline,temporarilyOffline,numExecutors,idle,assignedLabels[name]]',
      },
    });

    const nodes = (response.data.computer || []).map((node: any) => ({
      name: node.displayName,
      description: node.description || null,
      status: node.offline ? (node.temporarilyOffline ? 'temporarily-offline' : 'offline') : 'online',
      idle: node.idle,
      numExecutors: node.numExecutors,
      labels: (node.assignedLabels || []).map((l: any) => l.name).filter(Boolean),
    }));

    const online = nodes.filter((n: any) => n.status === 'online').length;
    const offline = nodes.length - online;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ summary: { total: nodes.length, online, offline }, nodes }, null, 2),
      }],
    };
  }

  /**
   * toggle_job
   * Enables or disables a Jenkins job via POST to /enable or /disable.
   */
  private async toggleJob(args: any) {
    if (!args?.jobPath) throw new McpError(ErrorCode.InvalidParams, 'jobPath is required');
    if (!['enable', 'disable'].includes(args.action)) {
      throw new McpError(ErrorCode.InvalidParams, 'action must be "enable" or "disable"');
    }

    const crumbResp = await this.axiosInstance.get('/crumbIssuer/api/json');
    await this.axiosInstance.post(`/${args.jobPath}/${args.action}`, {}, {
      headers: { [crumbResp.data.crumbRequestField]: crumbResp.data.crumb },
    });

    return {
      content: [{
        type: 'text',
        text: `Job "${args.jobPath}" has been ${args.action}d successfully.`,
      }],
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NEW: DISCOVERY
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * search_jobs
   * Searches all top-level jobs by name (substring match). Returns matching jobs
   * with their last build status.
   */
  private async searchJobs(args: any) {
    if (!args?.query) throw new McpError(ErrorCode.InvalidParams, 'query is required');
    const query: string = args.query;
    const caseSensitive: boolean = args.caseSensitive ?? false;

    const response = await this.axiosInstance.get('/api/json', {
      params: { tree: 'jobs[name,url,color,lastBuild[number,result,url]]' },
    });

    const needle = caseSensitive ? query : query.toLowerCase();

    const matches = (response.data.jobs || [])
      .filter((job: any) => {
        const haystack = caseSensitive ? job.name : job.name.toLowerCase();
        return haystack.includes(needle);
      })
      .map((job: any) => ({
        name: job.name,
        url: job.url,
        lastBuildResult: job.lastBuild?.result ?? null,
        lastBuildNumber: job.lastBuild?.number ?? null,
        lastBuildUrl: job.lastBuild?.url ?? null,
        statusColor: job.color,
      }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ query, count: matches.length, matches }, null, 2),
      }],
    };
  }

  /**
   * get_job_parameters
   * Returns all parameter definitions for a job: name, type, default value, and description.
   * Useful before calling trigger_build so you know exactly what to pass.
   */
  private async getJobParameters(args: any) {
    if (!args?.jobPath) throw new McpError(ErrorCode.InvalidParams, 'jobPath is required');

    const response = await this.axiosInstance.get(`/${args.jobPath}/api/json`, {
      params: {
        tree: 'property[parameterDefinitions[name,type,description,defaultParameterValue[value]]]',
      },
    });

    const paramDefs = (response.data.property || [])
      .flatMap((prop: any) => prop.parameterDefinitions || [])
      .map((p: any) => ({
        name: p.name,
        type: p.type,
        description: p.description || null,
        defaultValue: p.defaultParameterValue?.value ?? null,
      }));

    if (paramDefs.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `Job "${args.jobPath}" has no defined parameters (it is a non-parameterized job).`,
        }],
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ jobPath: args.jobPath, parameterCount: paramDefs.length, parameters: paramDefs }, null, 2),
      }],
    };
  }

  // ─── Bootstrap ────────────────────────────────────────────────────────────

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Jenkins MCP server running on stdio');
  }
}

const server = new JenkinsServer();
server.run().catch(console.error);
