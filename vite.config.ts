import { readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const CONFIG_SAVE_ROUTE = "/api/save-config";
const CONFIG_PATH = path.resolve(process.cwd(), "src/eruvConfig.json");
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

function sendResponse(
  response: ServerResponse,
  statusCode: number,
  body: string,
) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(body);
}

function readRequestJson(request: IncomingMessage) {
  return new Promise<unknown>((resolve, reject) => {
    let body = "";

    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");

      if (body.length > MAX_REQUEST_BYTES) {
        reject(new Error("Config payload is too large."));
        request.destroy();
      }
    });

    request.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });

    request.on("error", reject);
  });
}

function getConfigFromPayload(payload: unknown) {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("config" in payload) ||
    !payload.config ||
    typeof payload.config !== "object"
  ) {
    throw new Error("Request must include a config object.");
  }

  return payload.config;
}

function eruvConfigSavePlugin(): Plugin {
  return {
    name: "eruv-config-save",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(CONFIG_SAVE_ROUTE, async (request, response) => {
        if (request.method !== "POST") {
          sendResponse(response, 405, "Use POST to save the config.");
          return;
        }

        try {
          const payload = await readRequestJson(request);
          const config = getConfigFromPayload(payload);
          const existingConfig = await readFile(CONFIG_PATH, "utf8").catch(
            () => "",
          );
          const trailingNewline = existingConfig.endsWith("\n") ? "\n" : "";
          const formattedConfig = `${JSON.stringify(
            config,
            null,
            2,
          )}${trailingNewline}`;

          if (existingConfig !== formattedConfig) {
            await writeFile(CONFIG_PATH, formattedConfig, "utf8");
          }

          sendResponse(response, 200, "Saved eruvConfig.json");
        } catch (error) {
          sendResponse(
            response,
            400,
            error instanceof Error ? error.message : "Unable to save config.",
          );
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), eruvConfigSavePlugin()],
});
