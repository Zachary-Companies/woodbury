import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const databaseQueryDefinition: ToolDefinition = {
  name: 'database_query',
  description: 'Execute a database query. Supports SQLite (better-sqlite3), PostgreSQL (pg), and DynamoDB (@aws-sdk). Drivers must be installed separately.',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      engine: {
        type: 'string',
        description: 'Database engine: "sqlite", "postgres", or "dynamodb"'
      },
      query: {
        type: 'string',
        description: 'SQL query (for sqlite/postgres) or JSON command string for DynamoDB (e.g. {"operation":"scan"} or {"operation":"get","key":{"id":"123"}})'
      },
      connectionString: {
        type: 'string',
        description: 'Connection string — file path for SQLite, connection URI for PostgreSQL'
      },
      tableName: {
        type: 'string',
        description: 'Table name (required for DynamoDB operations)'
      },
      region: {
        type: 'string',
        description: 'AWS region for DynamoDB (default: "us-east-1")',
        default: 'us-east-1'
      }
    },
    required: ['engine', 'query']
  }
};

export const databaseQueryHandler: ToolHandler = async (params: any, context?: ToolContext) => {
  const engine = params.engine as string;
  const query = params.query as string;
  const connectionString = params.connectionString as string | undefined;
  const tableName = params.tableName as string | undefined;
  const region = (params.region as string) || 'us-east-1';
  
  if (!engine) {
    throw new Error('engine parameter is required');
  }
  
  if (!query) {
    throw new Error('query parameter is required');
  }
  
  try {
    switch (engine.toLowerCase()) {
      case 'sqlite': {
        if (!connectionString) {
          throw new Error('SQLite requires a file path in connectionString');
        }
        
        try {
          const Database = require('better-sqlite3');
          const db = new Database(connectionString);
          
          // Determine if it's a SELECT query or not
          const isSelect = query.trim().toLowerCase().startsWith('select');
          
          if (isSelect) {
            const stmt = db.prepare(query);
            const rows = stmt.all();
            db.close();
            return `Query executed successfully. Returned ${rows.length} rows:\n${JSON.stringify(rows, null, 2)}`;
          } else {
            const stmt = db.prepare(query);
            const result = stmt.run();
            db.close();
            return `Query executed successfully. Changed ${result.changes} rows. Last insert ID: ${result.lastInsertRowid}`;
          }
        } catch (requireError: any) {
          throw new Error(`SQLite driver not available: ${requireError.message}. Install with: npm install better-sqlite3`);
        }
      }

      case 'postgres': {
        if (!connectionString) {
          throw new Error('PostgreSQL requires a connection string');
        }
        
        try {
          const { Client } = require('pg');
          const client = new Client(connectionString);
          
          await client.connect();
          const result = await client.query(query);
          await client.end();
          
          return `Query executed successfully. Returned ${result.rowCount || result.rows.length} rows:\n${JSON.stringify(result.rows, null, 2)}`;
        } catch (requireError: any) {
          throw new Error(`PostgreSQL driver not available: ${requireError.message}. Install with: npm install pg`);
        }
      }

      case 'dynamodb': {
        if (!tableName) {
          throw new Error('DynamoDB requires a tableName parameter');
        }
        
        try {
          const { DynamoDBClient, ScanCommand, GetItemCommand, PutItemCommand, DeleteItemCommand, QueryCommand } = require('@aws-sdk/client-dynamodb');
          const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
          
          const client = new DynamoDBClient({ region });
          
          let parsedQuery;
          try {
            parsedQuery = JSON.parse(query);
          } catch {
            throw new Error('DynamoDB query must be valid JSON');
          }
          
          const { operation } = parsedQuery;
          
          switch (operation) {
            case 'scan': {
              const command = new ScanCommand({ TableName: tableName });
              const response = await client.send(command);
              const items = response.Items?.map((item: any) => unmarshall(item)) || [];
              return `Scan completed. Returned ${items.length} items:\n${JSON.stringify(items, null, 2)}`;
            }
            
            case 'get': {
              const { key } = parsedQuery;
              if (!key) {
                throw new Error('DynamoDB get operation requires a key');
              }
              const command = new GetItemCommand({
                TableName: tableName,
                Key: marshall(key)
              });
              const response = await client.send(command);
              const item = response.Item ? unmarshall(response.Item) : null;
              return `Get completed. ${item ? 'Item found' : 'Item not found'}:\n${JSON.stringify(item, null, 2)}`;
            }
            
            case 'put': {
              const { item } = parsedQuery;
              if (!item) {
                throw new Error('DynamoDB put operation requires an item');
              }
              const command = new PutItemCommand({
                TableName: tableName,
                Item: marshall(item)
              });
              await client.send(command);
              return 'Item created/updated successfully';
            }
            
            case 'delete': {
              const { key } = parsedQuery;
              if (!key) {
                throw new Error('DynamoDB delete operation requires a key');
              }
              const command = new DeleteItemCommand({
                TableName: tableName,
                Key: marshall(key)
              });
              await client.send(command);
              return 'Item deleted successfully';
            }
            
            case 'query': {
              const { keyConditionExpression, expressionAttributeValues } = parsedQuery;
              if (!keyConditionExpression) {
                throw new Error('DynamoDB query operation requires keyConditionExpression');
              }
              const command = new QueryCommand({
                TableName: tableName,
                KeyConditionExpression: keyConditionExpression,
                ExpressionAttributeValues: expressionAttributeValues ? marshall(expressionAttributeValues) : undefined
              });
              const response = await client.send(command);
              const items = response.Items?.map((item: any) => unmarshall(item)) || [];
              return `Query completed. Returned ${items.length} items:\n${JSON.stringify(items, null, 2)}`;
            }
            
            default:
              throw new Error(`Unsupported DynamoDB operation: ${operation}. Supported: scan, get, put, delete, query`);
          }
        } catch (requireError: any) {
          throw new Error(`DynamoDB SDK not available: ${requireError.message}. Install with: npm install @aws-sdk/client-dynamodb @aws-sdk/util-dynamodb`);
        }
      }

      default:
        throw new Error(`Unsupported database engine: ${engine}. Supported: sqlite, postgres, dynamodb`);
    }
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Database query failed: ${error.message}`);
    }
    throw new Error(`Database query failed: ${String(error)}`);
  }
};
