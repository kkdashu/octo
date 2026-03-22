#!/usr/bin/env node

import { Command } from 'commander';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MiniCowork } from './runner';
import { loadAppConfig, resolveConfigPath } from './settings';
import { DEFAULT_PROVIDERS } from './config/providers';

const program = new Command();

program
  .name('mini-cowork')
  .description('Standalone multi-provider Claude Agent SDK CLI')
  .version('0.1.0');

// Global options
program
  .option('-c, --config <path>', 'Path to config file')
  .option('-d, --dir <path>', 'Working directory for tool execution')
  .option('--system <prompt>', 'System prompt')
  .option('--silent', 'Suppress info logs');

program
  .command('run [prompt...]')
  .description('Run a single prompt (non-interactive)')
  .option('--auto-approve', 'Auto-approve all tool permissions')
  .option('--session <id>', 'Continue a previous session by ID')
  .action(async (promptParts: string[], cmdOptions: { autoApprove?: boolean; session?: string }) => {
    const globalOpts = program.opts<{ config?: string; dir?: string; system?: string; silent?: boolean }>();
    const prompt = promptParts.join(' ');

    if (!prompt.trim()) {
      console.error('Error: prompt is required');
      process.exit(1);
    }

    const runner = new MiniCowork({
      configPath: globalOpts.config,
      workingDirectory: globalOpts.dir,
      systemPrompt: globalOpts.system,
      silent: globalOpts.silent,
    });

    try {
      await runner.start();
    } catch (error) {
      console.error('Error starting runner:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }

    let hasError = false;
    try {
      for await (const event of runner.run({
        prompt,
        sessionId: cmdOptions.session,
        autoApprove: cmdOptions.autoApprove,
      })) {
        if (event.type === 'text') {
          process.stdout.write(event.content);
        } else if (event.type === 'thinking' && !globalOpts.silent) {
          process.stderr.write(`[thinking] ${event.content}\n`);
        } else if (event.type === 'tool_use' && !globalOpts.silent) {
          process.stderr.write(`[tool] ${event.name}(${JSON.stringify(event.input)})\n`);
        } else if (event.type === 'complete') {
          if (!globalOpts.silent && event.claudeSessionId) {
            process.stderr.write(`\n[session] ${event.claudeSessionId}\n`);
          }
        } else if (event.type === 'error') {
          console.error('\nError:', event.message);
          hasError = true;
        }
      }
      // Newline after streamed output
      process.stdout.write('\n');
    } finally {
      await runner.stop();
    }

    if (hasError) process.exit(1);
  });

program
  .command('interactive')
  .alias('i')
  .description('Start interactive REPL mode')
  .option('--auto-approve', 'Auto-approve all tool permissions')
  .action(async (cmdOptions: { autoApprove?: boolean }) => {
    const globalOpts = program.opts<{ config?: string; dir?: string; system?: string; silent?: boolean }>();

    const runner = new MiniCowork({
      configPath: globalOpts.config,
      workingDirectory: globalOpts.dir,
      systemPrompt: globalOpts.system,
      silent: globalOpts.silent,
    });

    try {
      await runner.start();
    } catch (error) {
      console.error('Error starting runner:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }

    const apiConfig = runner.getApiConfig();
    console.log(`mini-cowork interactive mode`);
    console.log(`Model: ${apiConfig?.model ?? 'unknown'}`);
    console.log(`Type your prompt and press Enter. Type "exit" or Ctrl+C to quit.\n`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> ',
    });

    let sessionId: string | undefined;

    const processLine = async (line: string) => {
      const prompt = line.trim();
      if (!prompt) {
        rl.prompt();
        return;
      }
      if (prompt === 'exit' || prompt === 'quit') {
        rl.close();
        return;
      }

      rl.pause();
      try {
        for await (const event of runner.run({ prompt, sessionId, autoApprove: cmdOptions.autoApprove })) {
          if (event.type === 'text') {
            process.stdout.write(event.content);
          } else if (event.type === 'thinking' && !globalOpts.silent) {
            process.stderr.write(`[thinking] ${event.content}\n`);
          } else if (event.type === 'tool_use' && !globalOpts.silent) {
            process.stderr.write(`[tool] ${event.name}\n`);
          } else if (event.type === 'complete') {
            if (event.claudeSessionId) {
              sessionId = event.claudeSessionId;
            }
          } else if (event.type === 'error') {
            console.error('\nError:', event.message);
          }
        }
        process.stdout.write('\n');
      } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : String(error));
      }

      rl.resume();
      rl.prompt();
    };

    rl.on('line', (line) => {
      void processLine(line);
    });

    rl.on('close', async () => {
      await runner.stop();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      runner.abort();
      await runner.stop();
      process.exit(0);
    });

    rl.prompt();
  });

program
  .command('config')
  .description('Manage mini_cowork configuration')
  .addCommand(
    new Command('show')
      .description('Show current configuration')
      .action(() => {
        const globalOpts = program.opts<{ config?: string }>();
        const configPath = resolveConfigPath(globalOpts.config);
        if (!configPath) {
          console.log('No config file found.');
          console.log('Create one at:');
          console.log('  ~/.mini_cowork/config.json  (global)');
          console.log('  ./mini_cowork.config.json   (project-local)');
          return;
        }

        console.log('Config file:', configPath);
        const config = loadAppConfig(globalOpts.config);
        if (config) {
          console.log(JSON.stringify(config, null, 2));
        }
      })
  )
  .addCommand(
    new Command('init')
      .description('Create a default config file')
      .option('--global', 'Create in ~/.mini_cowork/ (default is project-local)')
      .action((cmdOptions: { global?: boolean }) => {
        const targetPath = cmdOptions.global
          ? path.join(os.homedir(), '.mini_cowork', 'config.json')
          : path.join(process.cwd(), 'mini_cowork.config.json');

        const targetDir = path.dirname(targetPath);
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }

        if (fs.existsSync(targetPath)) {
          console.error(`Config already exists at ${targetPath}`);
          process.exit(1);
        }

        const defaultConfig = {
          model: {
            defaultModel: 'deepseek-chat',
          },
          providers: {
            deepseek: {
              enabled: true,
              apiKey: 'YOUR_DEEPSEEK_API_KEY',
              baseUrl: DEFAULT_PROVIDERS.deepseek.baseUrl,
              apiFormat: 'anthropic',
              models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
            },
          },
        };

        fs.writeFileSync(targetPath, JSON.stringify(defaultConfig, null, 2), 'utf8');
        console.log(`Created config at: ${targetPath}`);
        console.log('Edit the file to add your API key and enable providers.');
      })
  )
  .addCommand(
    new Command('list-providers')
      .description('List all supported providers and their default endpoints')
      .action(() => {
        console.log('Supported providers:\n');
        for (const [name, config] of Object.entries(DEFAULT_PROVIDERS)) {
          const models = config.models?.map((m) => m.id).join(', ') ?? 'none';
          console.log(`${name}`);
          console.log(`  Base URL:   ${config.baseUrl}`);
          console.log(`  API Format: ${config.apiFormat ?? 'anthropic'}`);
          console.log(`  Models:     ${models}`);
          console.log();
        }
      })
  );

// Default command: interactive mode when no subcommand given
program.action(async () => {
  // Redirect to interactive mode
  const globalOpts = program.opts<{ config?: string; dir?: string; system?: string; silent?: boolean }>();

  const runner = new MiniCowork({
    configPath: globalOpts.config,
    workingDirectory: globalOpts.dir,
    systemPrompt: globalOpts.system,
    silent: globalOpts.silent,
  });

  try {
    await runner.start();
  } catch (error) {
    console.error('Error starting runner:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const apiConfig = runner.getApiConfig();
  console.log(`mini-cowork interactive mode`);
  console.log(`Model: ${apiConfig?.model ?? 'unknown'}`);
  console.log(`Type your prompt and press Enter. Type "exit" or Ctrl+C to quit.\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  let sessionId: string | undefined;

  const processLine = async (line: string) => {
    const prompt = line.trim();
    if (!prompt) { rl.prompt(); return; }
    if (prompt === 'exit' || prompt === 'quit') { rl.close(); return; }

    rl.pause();
    try {
      for await (const event of runner.run({ prompt, sessionId })) {
        if (event.type === 'text') {
          process.stdout.write(event.content);
        } else if (event.type === 'complete' && event.claudeSessionId) {
          sessionId = event.claudeSessionId;
        } else if (event.type === 'error') {
          console.error('\nError:', event.message);
        }
      }
      process.stdout.write('\n');
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
    }

    rl.resume();
    rl.prompt();
  };

  rl.on('line', (line) => { void processLine(line); });
  rl.on('close', async () => { await runner.stop(); process.exit(0); });
  process.on('SIGINT', async () => { runner.abort(); await runner.stop(); process.exit(0); });

  rl.prompt();
});

program.parseAsync(process.argv).catch((error) => {
  console.error('Fatal error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
