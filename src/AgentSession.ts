import { input } from './utils';

export class AgentSession {
  private workingDirectory: string;

  constructor() {
    this.workingDirectory = process.cwd();
  }

  public getWorkingDirectory(): string {
    return this.workingDirectory;
  }

  public async processMessage(message: string): Promise<string> {
    try {
      // This is a simplified implementation
      // In the real implementation, this would use the LLM service
      // and various tools to process the user's message
      
      if (message.toLowerCase().includes('hello')) {
        return 'Hello! I\'m woodbury, your AI coding assistant. How can I help you today?';
      }
      
      if (message.toLowerCase().includes('quit') || message.toLowerCase().includes('exit')) {
        return 'Goodbye!';
      }
      
      if (message.toLowerCase().includes('current directory') || message.toLowerCase().includes('pwd')) {
        return `Current directory: ${this.workingDirectory}`;
      }
      
      // For now, just echo the message with some formatting
      return `I received your message: "${message}". I'm still learning how to respond properly!`;
    } catch (error) {
      throw new Error(`Failed to process message: ${error}`);
    }
  }

  public async run(): Promise<void> {
    console.log('Starting woodbury session...');
    console.log('Type "quit" or "exit" to end the session.');
    
    while (true) {
      try {
        const userInput = await input('woodbury> ');
        
        if (userInput.toLowerCase().trim() === 'quit' || 
            userInput.toLowerCase().trim() === 'exit') {
          console.log('Goodbye!');
          break;
        }
        
        const response = await this.processMessage(userInput);
        console.log(response);
      } catch (error) {
        console.error('Error:', error);
      }
    }
  }
}
