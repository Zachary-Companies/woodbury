import { Agent } from './agent.js';
import { ToolRegistry } from './tool-registry.js';
import { Logger, AgentConfig } from './types.js';

// Import all tools
import { fileReadDefinition, fileReadHandler } from './tools/file-read.js';
import { fileWriteDefinition, fileWriteHandler } from './tools/file-write.js';
import { listDirectoryDefinition, listDirectoryHandler } from './tools/list-directory.js';
import { codeExecuteDefinition, codeExecuteHandler } from './tools/code-execute.js';
import { testRunnerDefinition, testRunnerHandler } from './tools/test-runner.js';
import { fileSearchDefinition, fileSearchHandler } from './tools/file-search.js';
import { grepDefinition, grepHandler } from './tools/grep.js';
import { shellExecuteDefinition, shellExecuteHandler } from './tools/shell-execute.js';
import { gitDefinition, gitHandler } from './tools/git.js';
import { webFetchDefinition, webFetchHandler } from './tools/web-fetch.js';
import { databaseQueryDefinition, databaseQueryHandler } from './tools/database-query.js';
import { webCrawlDefinition, webCrawlHandler } from './tools/web-crawl.js';
import { webCrawlRenderedDefinition, webCrawlRenderedHandler } from './tools/web-crawl-rendered.js';
import { googleSearchDefinition, googleSearchHandler } from './tools/google-search.js';
import { duckduckgoSearchDefinition, duckduckgoSearchHandler } from './tools/duckduckgo-search.js';
import { apiSearchDefinition, apiSearchHandler } from './tools/api-search.js';

// Import meta tools
import { definition as taskCreateDefinition, handler as taskCreateHandler } from './tools/task-create.js';
import { definition as taskUpdateDefinition, handler as taskUpdateHandler } from './tools/task-update.js';
import { definition as taskListDefinition, handler as taskListHandler } from './tools/task-list.js';
import { definition as taskGetDefinition, handler as taskGetHandler } from './tools/task-get.js';
import { definition as queueInitDefinition, handler as queueInitHandler } from './tools/queue-init.js';
import { definition as queueAddItemsDefinition, handler as queueAddItemsHandler } from './tools/queue-add-items.js';
import { definition as queueNextDefinition, handler as queueNextHandler } from './tools/queue-next.js';
import { definition as queueDoneDefinition, handler as queueDoneHandler } from './tools/queue-done.js';
import { definition as queueStatusDefinition, handler as queueStatusHandler } from './tools/queue-status.js';
import { definition as delegateDefinition, handler as delegateHandler } from './tools/delegate.js';
import { definition as goalContractDefinition, handler as goalContractHandler } from './tools/goal-contract.js';
import { definition as reflectDefinition, handler as reflectHandler } from './tools/reflect.js';
import { definition as memorySaveDefinition, handler as memorySaveHandler } from './tools/memory-save.js';
import { definition as memoryRecallDefinition, handler as memoryRecallHandler } from './tools/memory-recall.js';
import { definition as preflightCheckDefinition, handler as preflightCheckHandler } from './tools/preflight-check.js';

export { Agent };

export class AgentFactory {
  static create(config: Partial<AgentConfig> = {}): Agent {
    const fullConfig: AgentConfig = {
      name: 'default',
      ...config
    } as AgentConfig;
    const logger = fullConfig.logger || console;
    const registry = new ToolRegistry(logger);

    // Register core tools
    registry.register(fileReadDefinition, fileReadHandler);
    registry.register(fileWriteDefinition, fileWriteHandler);
    registry.register(listDirectoryDefinition, listDirectoryHandler);
    registry.register(codeExecuteDefinition, codeExecuteHandler);
    registry.register(testRunnerDefinition, testRunnerHandler);
    registry.register(fileSearchDefinition, fileSearchHandler);
    registry.register(grepDefinition, grepHandler);
    registry.register(shellExecuteDefinition, shellExecuteHandler);
    registry.register(gitDefinition, gitHandler);

    // Register web tools
    registry.register(webFetchDefinition, webFetchHandler);
    registry.register(webCrawlDefinition, webCrawlHandler);
    registry.register(webCrawlRenderedDefinition, webCrawlRenderedHandler);
    registry.register(googleSearchDefinition, googleSearchHandler);
    registry.register(duckduckgoSearchDefinition, duckduckgoSearchHandler);
    registry.register(apiSearchDefinition, apiSearchHandler);

    // Register database tools
    registry.register(databaseQueryDefinition, databaseQueryHandler);

    // Register meta tools (task management, etc.)
    registry.register(taskCreateDefinition, taskCreateHandler);
    registry.register(taskUpdateDefinition, taskUpdateHandler);
    registry.register(taskListDefinition, taskListHandler);
    registry.register(taskGetDefinition, taskGetHandler);
    registry.register(queueInitDefinition, queueInitHandler);
    registry.register(queueAddItemsDefinition, queueAddItemsHandler);
    registry.register(queueNextDefinition, queueNextHandler);
    registry.register(queueDoneDefinition, queueDoneHandler);
    registry.register(queueStatusDefinition, queueStatusHandler);
    registry.register(delegateDefinition, delegateHandler);
    registry.register(goalContractDefinition, goalContractHandler);
    registry.register(reflectDefinition, reflectHandler);
    registry.register(memorySaveDefinition, memorySaveHandler);
    registry.register(memoryRecallDefinition, memoryRecallHandler);
    registry.register(preflightCheckDefinition, preflightCheckHandler);

    return new Agent(fullConfig, registry);
  }

  static createWithCustomTools(config: AgentConfig, customTools: Array<{ definition: any; handler: any }> = []): Agent {
    const agent = AgentFactory.create(config);
    
    // Add custom tools
    for (const { definition, handler } of customTools) {
      // Access registry through agent - will need to make it accessible
      // agent.registry.register(definition, handler);
    }
    
    return agent;
  }

  static getAvailableTools(): string[] {
    const agent = AgentFactory.create({ name: 'temp' });
    return agent.getAvailableTools();
  }
}
