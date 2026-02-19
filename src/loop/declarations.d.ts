declare module '@zachary/llm-service' {
    export interface ChatMessage {
        role: string;
        content: string;
        name?: string;
        [key: string]: any;
    }
    export const LLMService: any;
}

declare module '@zachary/knowledge-base' {
    const anything: any;
    export = anything;
}

declare module 'glob';
