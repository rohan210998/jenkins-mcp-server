#!/usr/bin/env node
import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/http.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";

const PORT = process.env.PORT || 3000;

const JENKINS_URL = process.env.JENKINS_URL || "";
const JENKINS_USER = process.env.JENKINS_USER || "";
const JENKINS_TOKEN = process.env.JENKINS_TOKEN || "";

class JenkinsServer {
  private server: Server;
  private axiosInstance: any;

  constructor() {
    this.server = new Server(
      {
        name: "jenkins-server",
        version: "0.1.0",
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

    this.server.onerror = (error) =>
      console.error("[MCP Error]", error);
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "list_all_jobs",
          description:
            "List all Jenkins jobs with their name, URL, and last build status.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
      ],
    }));

    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request) => {
        try {
          switch (request.params.name) {
            case "list_all_jobs":
              return await this.listAllJobs();

            default:
              throw new McpError(
                ErrorCode.MethodNotFound,
                `Unknown tool: ${request.params.name}`
              );
          }
        } catch (error: any) {
          if (axios.isAxiosError(error)) {
            throw new McpError(
              ErrorCode.InternalError,
              `Jenkins API error: ${
                error.response?.data?.message ||
                error.message
              }`
            );
          }

          throw new McpError(
            ErrorCode.InternalError,
            "Unknown error occurred"
          );
        }
      }
    );
  }

  private async listAllJobs() {
    const response = await this.axiosInstance.get("/api/json", {
      params: {
        tree: "jobs[name,url,color,lastBuild[number,result,url]]",
      },
    });

    const jobs = (response.data.jobs || []).map((job: any) => ({
      name: job.name,
      url: job.url,
      lastBuild: job.lastBuild
        ? {
            number: job.lastBuild.number,
            result: job.lastBuild.result,
            url: job.lastBuild.url,
          }
        : null,
      statusColor: job.color,
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              count: jobs.length,
              jobs,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  async run() {
    const app = express();

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await this.server.connect(transport);

    app.post("/mcp", async (req, res) => {
      await transport.handleRequest(req, res);
    });

    app.get("/health", (_, res) => {
      res.send("OK");
    });

    app.listen(PORT, () => {
      console.log(`🚀 Jenkins MCP server running on port ${PORT}`);
    });
  }
}

const server = new JenkinsServer();

server.run().catch(console.error);
