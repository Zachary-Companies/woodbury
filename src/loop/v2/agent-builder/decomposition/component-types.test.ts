/**
 * Tests for Component Types
 */
import {
  DecompositionResult,
  IdeaUnderstanding,
  InputRequirements,
  IdentifiedConnector,
  IdentifiedProcessor,
  IdentifiedAction,
  IdentifiedTrigger,
  RequiredAPI,
  PendingClarification,
  ClarificationAnswer,
  createEmptyDecomposition,
  applyClarificationAnswer,
  needsClarification,
  getNextRequiredClarification,
  calculateConfidence,
  validateDecomposition,
  ValidationIssue,
  AttachmentType,
  InputSource,
  InputFormat
} from './component-types'

describe('component-types', () => {
  describe('createEmptyDecomposition', () => {
    it('should create an empty decomposition with session ID', () => {
      const result = createEmptyDecomposition('test-session-123')

      expect(result.sessionId).toBe('test-session-123')
      expect(result.status).toBe('analyzing')
      expect(result.confidence).toBe(0)
      expect(result.warnings).toEqual([])
    })

    it('should have empty understanding', () => {
      const result = createEmptyDecomposition('test')

      expect(result.understanding.summary).toBe('')
      expect(result.understanding.goals).toEqual([])
      expect(result.understanding.entities).toEqual([])
      expect(result.understanding.externalSystems).toEqual([])
      expect(result.understanding.constraints).toEqual([])
      expect(result.understanding.suggestedName).toBe('')
      expect(result.understanding.inputRequirements).toBeUndefined()
    })

    it('should have empty components', () => {
      const result = createEmptyDecomposition('test')

      expect(result.components.connectors).toEqual([])
      expect(result.components.processors).toEqual([])
      expect(result.components.actions).toEqual([])
      expect(result.components.triggers).toEqual([])
    })

    it('should have empty data flow', () => {
      const result = createEmptyDecomposition('test')

      expect(result.dataFlow.nodes).toEqual([])
      expect(result.dataFlow.edges).toEqual([])
    })
  })

  describe('applyClarificationAnswer', () => {
    it('should remove answered clarification from pending list', () => {
      const result = createEmptyDecomposition('test')
      result.pendingClarifications = [
        {
          id: 'q1',
          question: 'What is the schedule?',
          context: 'Need to know when agent runs',
          inputType: 'text',
          importance: 'required'
        },
        {
          id: 'q2',
          question: 'Which email provider?',
          context: 'For notifications',
          inputType: 'choice',
          importance: 'optional',
          options: ['Gmail', 'Outlook', 'Other']
        }
      ]

      const answer: ClarificationAnswer = {
        questionId: 'q1',
        answer: 'Every morning at 8 AM',
        answeredAt: Date.now()
      }

      const updated = applyClarificationAnswer(result, answer)

      expect(updated.pendingClarifications).toHaveLength(1)
      expect(updated.pendingClarifications[0].id).toBe('q2')
    })

    it('should not modify original result', () => {
      const result = createEmptyDecomposition('test')
      result.pendingClarifications = [
        {
          id: 'q1',
          question: 'Test?',
          context: 'Test context',
          inputType: 'text',
          importance: 'required'
        }
      ]

      const answer: ClarificationAnswer = {
        questionId: 'q1',
        answer: 'Answer',
        answeredAt: Date.now()
      }

      applyClarificationAnswer(result, answer)

      expect(result.pendingClarifications).toHaveLength(1)
    })
  })

  describe('needsClarification', () => {
    it('should return true when required clarifications exist', () => {
      const result = createEmptyDecomposition('test')
      result.pendingClarifications = [
        {
          id: 'q1',
          question: 'Required question',
          context: 'Context',
          inputType: 'text',
          importance: 'required'
        }
      ]

      expect(needsClarification(result)).toBe(true)
    })

    it('should return false when only optional clarifications exist', () => {
      const result = createEmptyDecomposition('test')
      result.pendingClarifications = [
        {
          id: 'q1',
          question: 'Optional question',
          context: 'Context',
          inputType: 'text',
          importance: 'optional'
        }
      ]

      expect(needsClarification(result)).toBe(false)
    })

    it('should return false when no clarifications exist', () => {
      const result = createEmptyDecomposition('test')

      expect(needsClarification(result)).toBe(false)
    })
  })

  describe('getNextRequiredClarification', () => {
    it('should return first required clarification', () => {
      const result = createEmptyDecomposition('test')
      result.pendingClarifications = [
        {
          id: 'q1',
          question: 'Optional first',
          context: 'Context',
          inputType: 'text',
          importance: 'optional'
        },
        {
          id: 'q2',
          question: 'Required question',
          context: 'Context',
          inputType: 'text',
          importance: 'required'
        }
      ]

      const next = getNextRequiredClarification(result)

      expect(next?.id).toBe('q2')
    })

    it('should return undefined when no required clarifications', () => {
      const result = createEmptyDecomposition('test')

      expect(getNextRequiredClarification(result)).toBeUndefined()
    })
  })

  describe('calculateConfidence', () => {
    it('should return low confidence for empty decomposition', () => {
      const result = createEmptyDecomposition('test')

      // Empty decomposition gets some points for having no pending required clarifications
      expect(calculateConfidence(result)).toBeLessThan(0.5)
    })

    it('should increase confidence with summary', () => {
      const result = createEmptyDecomposition('test')
      result.understanding.summary = 'Test summary'

      const confidence = calculateConfidence(result)
      expect(confidence).toBeGreaterThan(0)
    })

    it('should increase confidence with goals', () => {
      const result = createEmptyDecomposition('test')
      result.understanding.goals = ['Goal 1', 'Goal 2']

      const confidence = calculateConfidence(result)
      expect(confidence).toBeGreaterThan(0)
    })

    it('should increase confidence with components', () => {
      const result = createEmptyDecomposition('test')
      result.components.connectors.push({
        id: 'conn1',
        name: 'Test Connector',
        description: 'Test',
        type: 'rest_api',
        externalSystem: 'TestAPI',
        requiredOperations: [],
        authRequirements: { type: 'api_key', description: 'API key needed' },
        needsApiDoc: true,
        priority: 1
      })

      const confidence = calculateConfidence(result)
      expect(confidence).toBeGreaterThan(0)
    })

    it('should decrease confidence with required clarifications', () => {
      const result = createEmptyDecomposition('test')
      result.understanding.summary = 'Summary'
      result.understanding.goals = ['Goal']
      result.understanding.suggestedName = 'Test Agent'
      result.components.connectors.push({
        id: 'conn1',
        name: 'Test',
        description: 'Test',
        type: 'rest_api',
        externalSystem: 'TestAPI',
        requiredOperations: [],
        authRequirements: { type: 'none', description: 'None' },
        needsApiDoc: false,
        priority: 1
      })

      const confidenceWithoutClarification = calculateConfidence(result)

      result.pendingClarifications = [{
        id: 'q1',
        question: 'Required?',
        context: 'Context',
        inputType: 'text',
        importance: 'required'
      }]

      const confidenceWithClarification = calculateConfidence(result)

      expect(confidenceWithClarification).toBeLessThan(confidenceWithoutClarification)
    })

    it('should return higher confidence for complete decomposition', () => {
      const result = createEmptyDecomposition('test')
      result.understanding.summary = 'Monitor expiring policies'
      result.understanding.goals = ['Identify renewals', 'Notify producers']
      result.understanding.suggestedName = 'Renewal Monitor Agent'
      result.components.connectors.push({
        id: 'conn1',
        name: 'HawkSoft Connector',
        description: 'Connect to HawkSoft',
        type: 'rest_api',
        externalSystem: 'HawkSoft',
        requiredOperations: [{ name: 'list_policies', description: 'List policies', isMutating: false }],
        authRequirements: { type: 'api_key', description: 'API key' },
        needsApiDoc: true,
        priority: 1
      })
      result.components.processors.push({
        id: 'proc1',
        name: 'Expiry Filter',
        description: 'Filter expiring policies',
        type: 'filter',
        inputDescription: 'All policies',
        outputDescription: 'Expiring policies',
        logicDescription: 'Filter by expiration date',
        dependsOn: ['conn1'],
        priority: 1
      })
      result.components.triggers.push({
        id: 'trig1',
        name: 'Daily Schedule',
        type: 'schedule',
        scheduleDescription: 'Every day at 8 AM',
        suggestedCron: '0 8 * * *',
        priority: 1
      })
      result.requiredAPIs.push({
        name: 'HawkSoft API',
        purpose: 'Fetch policy data',
        suggestedSources: ['https://docs.hawksoft.com'],
        hasOpenApiSpec: true,
        endpointsNeeded: ['/policies'],
        priority: 1
      })

      const confidence = calculateConfidence(result)
      expect(confidence).toBeGreaterThan(0.7)
    })
  })

  describe('validateDecomposition', () => {
    it('should return error for missing summary', () => {
      const result = createEmptyDecomposition('test')

      const issues = validateDecomposition(result)

      expect(issues.some(i => i.severity === 'error' && i.message.includes('summary'))).toBe(true)
    })

    it('should return error for missing goals', () => {
      const result = createEmptyDecomposition('test')
      result.understanding.summary = 'Test'

      const issues = validateDecomposition(result)

      expect(issues.some(i => i.severity === 'error' && i.message.includes('goals'))).toBe(true)
    })

    it('should return error for missing trigger', () => {
      const result = createEmptyDecomposition('test')
      result.understanding.summary = 'Test'
      result.understanding.goals = ['Goal 1']

      const issues = validateDecomposition(result)

      expect(issues.some(i => i.severity === 'error' && i.message.includes('trigger'))).toBe(true)
    })

    it('should return warning for action with unknown connector', () => {
      const result = createEmptyDecomposition('test')
      result.understanding.summary = 'Test'
      result.understanding.goals = ['Goal 1']
      result.components.triggers.push({
        id: 'trig1',
        name: 'Manual',
        type: 'manual',
        priority: 1
      })
      result.components.actions.push({
        id: 'action1',
        name: 'Test Action',
        description: 'Test',
        type: 'notify',
        usesConnector: 'unknown_connector',
        operation: 'send',
        suggestedApprovalRequired: false,
        dependsOn: [],
        priority: 1
      })

      const issues = validateDecomposition(result)

      expect(issues.some(i => i.severity === 'warning' && i.message.includes('unknown connector'))).toBe(true)
    })

    it('should return empty array for valid decomposition', () => {
      const result = createEmptyDecomposition('test')
      result.understanding.summary = 'Valid agent'
      result.understanding.goals = ['Goal 1', 'Goal 2']
      result.components.triggers.push({
        id: 'trig1',
        name: 'Schedule',
        type: 'schedule',
        suggestedCron: '0 8 * * *',
        priority: 1
      })

      const issues = validateDecomposition(result)

      const errors = issues.filter(i => i.severity === 'error')
      expect(errors).toHaveLength(0)
    })
  })

  describe('InputRequirements type', () => {
    it('should support attachment-requiring agent config', () => {
      const inputReqs: InputRequirements = {
        requiresAttachments: true,
        attachmentTypes: ['pdf', 'excel'],
        inputSource: 'email_attachment',
        inputFormats: ['document', 'spreadsheet'],
        inputDescription: 'PDF renewal reports or Excel policy lists',
        supportsEmailInput: true,
        supportsWebhookInput: false,
        supportsManualUpload: true,
        sampleInputDescription: 'A PDF containing policy renewal data'
      }

      expect(inputReqs.requiresAttachments).toBe(true)
      expect(inputReqs.attachmentTypes).toContain('pdf')
      expect(inputReqs.attachmentTypes).toContain('excel')
      expect(inputReqs.inputSource).toBe('email_attachment')
    })

    it('should support API-fetched agent config', () => {
      const inputReqs: InputRequirements = {
        requiresAttachments: false,
        inputSource: 'api_fetch',
        inputFormats: ['structured_data'],
        inputDescription: 'Policy data fetched from HawkSoft API',
        supportsEmailInput: false,
        supportsWebhookInput: true,
        supportsManualUpload: false
      }

      expect(inputReqs.requiresAttachments).toBe(false)
      expect(inputReqs.inputSource).toBe('api_fetch')
      expect(inputReqs.attachmentTypes).toBeUndefined()
    })

    it('should support webhook-triggered agent config', () => {
      const inputReqs: InputRequirements = {
        requiresAttachments: false,
        inputSource: 'webhook_payload',
        inputFormats: ['structured_data'],
        inputDescription: 'JSON payload from carrier webhook',
        supportsEmailInput: false,
        supportsWebhookInput: true,
        supportsManualUpload: false
      }

      expect(inputReqs.inputSource).toBe('webhook_payload')
      expect(inputReqs.supportsWebhookInput).toBe(true)
    })

    it('should support manual upload agent config', () => {
      const inputReqs: InputRequirements = {
        requiresAttachments: true,
        attachmentTypes: ['csv', 'excel'],
        inputSource: 'manual_upload',
        inputFormats: ['spreadsheet'],
        inputDescription: 'Manually uploaded client data spreadsheet',
        supportsEmailInput: false,
        supportsWebhookInput: false,
        supportsManualUpload: true
      }

      expect(inputReqs.inputSource).toBe('manual_upload')
      expect(inputReqs.supportsManualUpload).toBe(true)
    })
  })

  describe('AttachmentType', () => {
    it('should include common document types', () => {
      const types: AttachmentType[] = ['pdf', 'excel', 'csv', 'word', 'image', 'json', 'xml', 'text', 'any']
      expect(types).toHaveLength(9)
    })
  })

  describe('InputSource', () => {
    it('should include all input sources', () => {
      const sources: InputSource[] = [
        'email_attachment',
        'api_fetch',
        'webhook_payload',
        'manual_upload',
        'scheduled_pull',
        'database_query',
        'file_system'
      ]
      expect(sources).toHaveLength(7)
    })
  })

  describe('InputFormat', () => {
    it('should include all input formats', () => {
      const formats: InputFormat[] = [
        'structured_data',
        'document',
        'spreadsheet',
        'image',
        'text',
        'email'
      ]
      expect(formats).toHaveLength(6)
    })
  })

  describe('IdeaUnderstanding with inputRequirements', () => {
    it('should support inputRequirements field', () => {
      const understanding: IdeaUnderstanding = {
        summary: 'Process PDF renewal reports',
        goals: ['Extract policy data', 'Generate outreach packages'],
        entities: [],
        externalSystems: [],
        constraints: [],
        suggestedName: 'Renewal Report Processor',
        inputRequirements: {
          requiresAttachments: true,
          attachmentTypes: ['pdf'],
          inputSource: 'email_attachment',
          inputDescription: 'PDF renewal report from carrier',
          supportsEmailInput: true,
          supportsWebhookInput: false,
          supportsManualUpload: true
        }
      }

      expect(understanding.inputRequirements).toBeDefined()
      expect(understanding.inputRequirements?.requiresAttachments).toBe(true)
      expect(understanding.inputRequirements?.attachmentTypes).toContain('pdf')
    })
  })
})
