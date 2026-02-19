/**
 * Tests for Decomposition Prompts
 */
import {
  DECOMPOSITION_SYSTEM_PROMPT,
  ANALYZE_IDEA_PROMPT,
  IDENTIFY_COMPONENTS_PROMPT,
  DATA_FLOW_PROMPT,
  CLARIFICATION_PROMPT,
  getDecompositionToolDescriptions,
  formatClarificationQuestion,
  EXAMPLE_DECOMPOSITION,
  getDomainExamples
} from './prompts'

describe('prompts', () => {
  describe('DECOMPOSITION_SYSTEM_PROMPT', () => {
    it('should include agent architect role', () => {
      expect(DECOMPOSITION_SYSTEM_PROMPT).toContain('Agent Architect')
    })

    it('should describe connectors', () => {
      expect(DECOMPOSITION_SYSTEM_PROMPT).toContain('Connectors')
      expect(DECOMPOSITION_SYSTEM_PROMPT).toContain('REST APIs')
    })

    it('should describe processors', () => {
      expect(DECOMPOSITION_SYSTEM_PROMPT).toContain('Processors')
      expect(DECOMPOSITION_SYSTEM_PROMPT).toContain('Filter')
      expect(DECOMPOSITION_SYSTEM_PROMPT).toContain('Transform')
    })

    it('should describe actions', () => {
      expect(DECOMPOSITION_SYSTEM_PROMPT).toContain('Actions')
      expect(DECOMPOSITION_SYSTEM_PROMPT).toContain('Notify')
    })

    it('should describe triggers', () => {
      expect(DECOMPOSITION_SYSTEM_PROMPT).toContain('Triggers')
      expect(DECOMPOSITION_SYSTEM_PROMPT).toContain('Schedule')
    })

    it('should include input requirements analysis', () => {
      expect(DECOMPOSITION_SYSTEM_PROMPT).toContain('Input Requirements')
      expect(DECOMPOSITION_SYSTEM_PROMPT).toContain('attachments')
    })

    it('should include examples of attachment-requiring agents', () => {
      expect(DECOMPOSITION_SYSTEM_PROMPT).toContain('Process renewal reports')
      expect(DECOMPOSITION_SYSTEM_PROMPT).toContain('PDF attachments')
    })

    it('should include examples of non-attachment agents', () => {
      expect(DECOMPOSITION_SYSTEM_PROMPT).toContain('Monitor expiring policies')
      expect(DECOMPOSITION_SYSTEM_PROMPT).toContain('Fetches data via API')
    })
  })

  describe('ANALYZE_IDEA_PROMPT', () => {
    it('should include core purpose', () => {
      expect(ANALYZE_IDEA_PROMPT).toContain('Core Purpose')
    })

    it('should include data sources', () => {
      expect(ANALYZE_IDEA_PROMPT).toContain('Data Sources')
    })

    it('should include outputs', () => {
      expect(ANALYZE_IDEA_PROMPT).toContain('Outputs')
    })

    it('should include timing', () => {
      expect(ANALYZE_IDEA_PROMPT).toContain('Timing')
    })
  })

  describe('IDENTIFY_COMPONENTS_PROMPT', () => {
    it('should mention all component types', () => {
      expect(IDENTIFY_COMPONENTS_PROMPT).toContain('Connectors')
      expect(IDENTIFY_COMPONENTS_PROMPT).toContain('Processors')
      expect(IDENTIFY_COMPONENTS_PROMPT).toContain('Actions')
      expect(IDENTIFY_COMPONENTS_PROMPT).toContain('Triggers')
    })
  })

  describe('DATA_FLOW_PROMPT', () => {
    it('should describe data flow from trigger to action', () => {
      expect(DATA_FLOW_PROMPT).toContain('trigger')
      expect(DATA_FLOW_PROMPT).toContain('connectors')
      expect(DATA_FLOW_PROMPT).toContain('processors')
      expect(DATA_FLOW_PROMPT).toContain('actions')
    })
  })

  describe('CLARIFICATION_PROMPT', () => {
    it('should provide guidance for good questions', () => {
      expect(CLARIFICATION_PROMPT).toContain('Good clarification questions')
    })

    it('should warn against bad questions', () => {
      expect(CLARIFICATION_PROMPT).toContain('Bad clarification questions')
    })
  })

  describe('getDecompositionToolDescriptions', () => {
    it('should include all tool descriptions', () => {
      const descriptions = getDecompositionToolDescriptions()

      expect(descriptions).toContain('analyze_idea')
      expect(descriptions).toContain('ask_clarification')
      expect(descriptions).toContain('identify_connector')
      expect(descriptions).toContain('identify_processor')
      expect(descriptions).toContain('identify_action')
      expect(descriptions).toContain('identify_trigger')
      expect(descriptions).toContain('add_required_api')
      expect(descriptions).toContain('finalize_decomposition')
    })

    it('should include identify_input_requirements tool', () => {
      const descriptions = getDecompositionToolDescriptions()

      expect(descriptions).toContain('identify_input_requirements')
      expect(descriptions).toContain('requiresAttachments')
      expect(descriptions).toContain('attachmentTypes')
      expect(descriptions).toContain('inputSource')
      expect(descriptions).toContain('supportsEmailInput')
      expect(descriptions).toContain('supportsWebhookInput')
      expect(descriptions).toContain('supportsManualUpload')
    })

    it('should include attachment type options', () => {
      const descriptions = getDecompositionToolDescriptions()

      expect(descriptions).toContain('pdf')
      expect(descriptions).toContain('excel')
      expect(descriptions).toContain('csv')
      expect(descriptions).toContain('image')
    })

    it('should include input source options', () => {
      const descriptions = getDecompositionToolDescriptions()

      expect(descriptions).toContain('email_attachment')
      expect(descriptions).toContain('api_fetch')
      expect(descriptions).toContain('webhook_payload')
      expect(descriptions).toContain('manual_upload')
    })
  })

  describe('formatClarificationQuestion', () => {
    it('should format question with context', () => {
      const formatted = formatClarificationQuestion(
        'How often should the agent run?',
        'Need to determine the execution schedule'
      )

      expect(formatted).toContain('**Question:**')
      expect(formatted).toContain('How often should the agent run?')
      expect(formatted).toContain('Context:')
      expect(formatted).toContain('execution schedule')
    })

    it('should include options when provided', () => {
      const formatted = formatClarificationQuestion(
        'Which email provider?',
        'For sending notifications',
        ['Gmail', 'Outlook', 'SendGrid']
      )

      expect(formatted).toContain('**Options:**')
      expect(formatted).toContain('1. Gmail')
      expect(formatted).toContain('2. Outlook')
      expect(formatted).toContain('3. SendGrid')
    })

    it('should not include options section when none provided', () => {
      const formatted = formatClarificationQuestion(
        'Test question?',
        'Test context'
      )

      expect(formatted).not.toContain('**Options:**')
    })

    it('should handle empty options array', () => {
      const formatted = formatClarificationQuestion(
        'Test question?',
        'Test context',
        []
      )

      expect(formatted).not.toContain('**Options:**')
    })
  })

  describe('EXAMPLE_DECOMPOSITION', () => {
    it('should include renewal outreach example', () => {
      expect(EXAMPLE_DECOMPOSITION).toContain('Renewal Outreach Agent')
    })

    it('should include HawkSoft reference', () => {
      expect(EXAMPLE_DECOMPOSITION).toContain('HawkSoft')
    })

    it('should include all component types', () => {
      expect(EXAMPLE_DECOMPOSITION).toContain('Connectors')
      expect(EXAMPLE_DECOMPOSITION).toContain('Processors')
      expect(EXAMPLE_DECOMPOSITION).toContain('Actions')
      expect(EXAMPLE_DECOMPOSITION).toContain('Triggers')
    })

    it('should include cron expression', () => {
      expect(EXAMPLE_DECOMPOSITION).toContain('0 8 * * 1-5')
    })
  })

  describe('getDomainExamples', () => {
    it('should return insurance examples', () => {
      const examples = getDomainExamples('insurance')

      expect(examples).toContain('Renewal monitoring')
      expect(examples).toContain('Claims processing')
      expect(examples).toContain('Certificate requests')
    })

    it('should return email examples', () => {
      const examples = getDomainExamples('email')

      expect(examples).toContain('Inbox organizer')
      expect(examples).toContain('Auto-responder')
      expect(examples).toContain('Email summarizer')
    })

    it('should return CRM examples', () => {
      const examples = getDomainExamples('crm')

      expect(examples).toContain('Lead scoring')
      expect(examples).toContain('Follow-up reminder')
      expect(examples).toContain('Data enrichment')
    })

    it('should return general examples for unknown domain', () => {
      const examples = getDomainExamples('unknown')

      expect(examples).toContain('Report generator')
      expect(examples).toContain('Data sync')
    })

    it('should return general examples explicitly', () => {
      const examples = getDomainExamples('general')

      expect(examples).toContain('Report generator')
      expect(examples).toContain('Notification hub')
    })
  })
})
