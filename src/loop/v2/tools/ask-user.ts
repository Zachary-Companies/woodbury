/**
 * ask_user tool - Human-in-the-loop for clarifying questions
 */

import {
  NativeToolDefinition,
  NativeToolHandler,
  RegisteredNativeTool,
  ToolExecutionContext,
} from '../types';
import { AgentEventEmitter, QuestionEvent, QuestionResponse } from '../types/events';

/**
 * ask_user tool definition
 */
export const askUserDefinition: NativeToolDefinition = {
  name: 'ask_user',
  description: 'Ask the user a clarifying question when you need more information to proceed. Use this when requirements are unclear, when you need to make a choice between multiple valid approaches, or when you need user confirmation for an important decision.',
  input_schema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The question to ask the user. Be specific and clear.',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of choices for the user. If provided, user can select one of these or provide a custom answer.',
      },
      context: {
        type: 'string',
        description: 'Optional context explaining why you need this information and how it will affect the outcome.',
      },
      input_type: {
        type: 'string',
        enum: ['text', 'choice', 'confirm'],
        description: 'Type of input expected: "text" for free-form, "choice" for selecting from options, "confirm" for yes/no',
      },
    },
    required: ['question'],
  },
};

/**
 * Pending questions waiting for answers
 */
const pendingQuestions = new Map<string, {
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
}>();

/**
 * Submit an answer to a pending question
 */
export function submitAnswer(response: QuestionResponse): void {
  const pending = pendingQuestions.get(response.questionId);
  if (pending) {
    pending.resolve(response.answer);
    pendingQuestions.delete(response.questionId);
  }
}

/**
 * Cancel a pending question
 */
export function cancelQuestion(questionId: string, reason?: string): void {
  const pending = pendingQuestions.get(questionId);
  if (pending) {
    pending.reject(new Error(reason || 'Question was cancelled'));
    pendingQuestions.delete(questionId);
  }
}

/**
 * Cancel all pending questions
 */
export function cancelAllQuestions(reason?: string): void {
  for (const [questionId, pending] of pendingQuestions) {
    pending.reject(new Error(reason || 'All questions were cancelled'));
  }
  pendingQuestions.clear();
}

/**
 * Create ask_user handler with event emitter
 */
export function createAskUserHandler(
  eventEmitter: AgentEventEmitter,
  sessionId: string
): NativeToolHandler {
  return async (
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<string> => {
    const question = input.question as string;
    const options = input.options as string[] | undefined;
    const contextText = input.context as string | undefined;
    const inputType = (input.input_type as string) || (options ? 'choice' : 'text');

    // Generate unique question ID
    const questionId = `q-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Create promise for answer
    const answerPromise = new Promise<string>((resolve, reject) => {
      pendingQuestions.set(questionId, { resolve, reject });

      // Setup timeout
      if (context.timeoutMs) {
        setTimeout(() => {
          if (pendingQuestions.has(questionId)) {
            reject(new Error('Question timed out waiting for user response'));
            pendingQuestions.delete(questionId);
          }
        }, context.timeoutMs);
      }

      // Setup abort signal
      if (context.signal) {
        context.signal.addEventListener('abort', () => {
          if (pendingQuestions.has(questionId)) {
            reject(new Error('Question was aborted'));
            pendingQuestions.delete(questionId);
          }
        });
      }
    });

    // Emit question event
    eventEmitter.emit({
      type: 'question',
      timestamp: Date.now(),
      sessionId,
      questionId,
      question,
      options,
      context: contextText,
      inputType: inputType as 'text' | 'choice' | 'confirm',
    });

    // Wait for answer
    try {
      const answer = await answerPromise;
      return `User answered: ${answer}`;
    } catch (error) {
      throw error;
    }
  };
}

/**
 * Create registered ask_user tool
 */
export function createAskUserTool(
  eventEmitter: AgentEventEmitter,
  sessionId: string
): RegisteredNativeTool {
  return {
    definition: askUserDefinition,
    handler: createAskUserHandler(eventEmitter, sessionId),
    dangerous: false,
  };
}

/**
 * Check if there are pending questions
 */
export function hasPendingQuestions(): boolean {
  return pendingQuestions.size > 0;
}

/**
 * Get pending question count
 */
export function getPendingQuestionCount(): number {
  return pendingQuestions.size;
}
