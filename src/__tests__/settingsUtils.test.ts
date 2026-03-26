/**
 * Tests for SettingsView utility functions — field name humanization,
 * pipeline-inputs.json parsing, field grouping, and conditional visibility.
 */
import {
  humanizeFieldName,
  parseFriendlyInputs,
  buildFieldGroups,
  type FriendlyInput,
  type ConditionalGroup,
} from '../config-dashboard/react/utils/settingsUtils';

// ── humanizeFieldName ───────────────────────────────────────────

describe('humanizeFieldName', () => {
  it('should convert camelCase to title case', () => {
    expect(humanizeFieldName('projectType')).toBe('Project Type');
    expect(humanizeFieldName('storyIdea')).toBe('Story Idea');
    expect(humanizeFieldName('targetAudience')).toBe('Target Audience');
  });

  it('should handle single-word names', () => {
    expect(humanizeFieldName('genre')).toBe('Genre');
    expect(humanizeFieldName('mood')).toBe('Mood');
    expect(humanizeFieldName('title')).toBe('Title');
  });

  it('should handle multi-hump camelCase', () => {
    expect(humanizeFieldName('authorName')).toBe('Author Name');
    expect(humanizeFieldName('visualStyle')).toBe('Visual Style');
    expect(humanizeFieldName('episodeNumber')).toBe('Episode Number');
    expect(humanizeFieldName('callToAction')).toBe('Call To Action');
  });

  it('should handle already capitalized first letter', () => {
    expect(humanizeFieldName('ProjectType')).toBe('Project Type');
  });

  it('should handle empty string', () => {
    expect(humanizeFieldName('')).toBe('');
  });
});

// ── parseFriendlyInputs ─────────────────────────────────────────

describe('parseFriendlyInputs', () => {
  it('should return empty arrays for null/undefined input', () => {
    expect(parseFriendlyInputs(null)).toEqual({ inputs: [], conditional: {} });
    expect(parseFriendlyInputs(undefined)).toEqual({ inputs: [], conditional: {} });
  });

  it('should return empty arrays for empty data', () => {
    expect(parseFriendlyInputs({})).toEqual({ inputs: [], conditional: {} });
  });

  it('should parse friendlyInputs with all field types', () => {
    const data = {
      friendlyInputs: [
        { id: 'title', label: 'Working Title', type: 'text', description: 'A title', placeholder: 'Enter title' },
        { id: 'story', label: 'Story Idea', type: 'textarea', description: 'Your story', rows: 4 },
        { id: 'type', label: 'Project Type', type: 'select', description: 'Pick type', options: [{ value: 'film', label: 'Film' }] },
      ],
    };
    const result = parseFriendlyInputs(data);
    expect(result.inputs).toHaveLength(3);
    expect(result.inputs[0].label).toBe('Working Title');
    expect(result.inputs[0].type).toBe('text');
    expect(result.inputs[1].type).toBe('textarea');
    expect(result.inputs[1].rows).toBe(4);
    expect(result.inputs[2].type).toBe('select');
    expect(result.inputs[2].options).toEqual([{ value: 'film', label: 'Film' }]);
  });

  it('should parse required fields', () => {
    const data = {
      friendlyInputs: [
        { id: 'story', label: 'Story', type: 'textarea', description: 'Required', required: true },
      ],
    };
    const result = parseFriendlyInputs(data);
    expect(result.inputs[0].required).toBe(true);
  });

  it('should fall back to humanized label when label is missing', () => {
    const data = {
      friendlyInputs: [
        { id: 'targetAudience', type: 'text', description: 'Who is this for?' },
      ],
    };
    const result = parseFriendlyInputs(data);
    expect(result.inputs[0].label).toBe('Target Audience');
  });

  it('should parse conditional inputs', () => {
    const data = {
      friendlyInputs: [],
      conditionalInputs: {
        tv: {
          showWhen: ['TV Pilot', 'TV Episode'],
          inputs: [
            { id: 'seriesName', label: 'Series Name', type: 'text', description: 'TV series name' },
          ],
        },
      },
    };
    const result = parseFriendlyInputs(data);
    expect(result.conditional).toHaveProperty('tv');
    expect(result.conditional.tv.showWhen).toEqual(['TV Pilot', 'TV Episode']);
    expect(result.conditional.tv.inputs).toHaveLength(1);
  });

  it('should default unknown types to text', () => {
    const data = {
      friendlyInputs: [
        { id: 'field1', type: 'number', description: 'A number field' },
        { id: 'field2', description: 'No type specified' },
      ],
    };
    const result = parseFriendlyInputs(data);
    expect(result.inputs[0].type).toBe('text');
    expect(result.inputs[1].type).toBe('text');
  });
});

// ── buildFieldGroups ────────────────────────────────────────────

describe('buildFieldGroups', () => {
  const mockPorts = [
    { name: 'projectType', type: 'string', description: 'What kind of project?' },
    { name: 'storyIdea', type: 'string', description: 'Describe your story' },
    { name: 'title', type: 'string', description: 'A title' },
    { name: 'genre', type: 'string', description: 'Genre' },
  ];

  describe('fallback mode (no friendly inputs)', () => {
    it('should create a single group from ports with humanized labels', () => {
      const groups = buildFieldGroups(null, null, mockPorts, {});
      expect(groups).toHaveLength(1);
      expect(groups[0].id).toBe('default');
      expect(groups[0].fields).toHaveLength(4);
      expect(groups[0].fields[0].label).toBe('Project Type');
      expect(groups[0].fields[1].label).toBe('Story Idea');
    });

    it('should return single group for empty friendly inputs array', () => {
      const groups = buildFieldGroups([], null, mockPorts, {});
      expect(groups).toHaveLength(1);
      expect(groups[0].id).toBe('default');
    });
  });

  describe('with friendly inputs', () => {
    const friendlyInputs: FriendlyInput[] = [
      { id: 'projectType', label: 'Project Type', type: 'select', description: 'Type', required: true },
      { id: 'storyIdea', label: 'Story Idea', type: 'textarea', description: 'Your story', required: true },
      { id: 'title', label: 'Working Title', type: 'text', description: 'Optional title' },
      { id: 'authorName', label: 'Your Name', type: 'text', description: 'For credits' },
      { id: 'genre', label: 'Genre', type: 'text', description: 'Genres' },
      { id: 'mood', label: 'Mood & Tone', type: 'text', description: 'Feel' },
      { id: 'visualStyle', label: 'Visual Style', type: 'text', description: 'Look' },
      { id: 'targetAudience', label: 'Target Audience', type: 'text', description: 'Audience' },
      { id: 'length', label: 'Approximate Length', type: 'text', description: 'Duration' },
      { id: 'additionalNotes', label: 'Additional Notes', type: 'textarea', description: 'Notes' },
      { id: 'projectFolder', label: 'Project Folder', type: 'text', description: 'Location', required: true },
    ];

    const conditionalInputs: Record<string, ConditionalGroup> = {
      tv: {
        showWhen: ['TV Pilot', 'TV Episode'],
        inputs: [
          { id: 'seriesName', label: 'Series Name', type: 'text', description: 'TV series' },
        ],
      },
      commercial: {
        showWhen: ['Commercial'],
        inputs: [
          { id: 'brandName', label: 'Brand', type: 'text', description: 'Brand name' },
        ],
      },
    };

    it('should create grouped layout with essentials, creative, production', () => {
      const groups = buildFieldGroups(friendlyInputs, null, mockPorts, {});
      const essentials = groups.find(g => g.id === 'essentials');
      expect(essentials!.fields.map(f => f.id)).toEqual(['projectType', 'storyIdea', 'title', 'authorName']);

      const creative = groups.find(g => g.id === 'creative');
      expect(creative!.columns).toBe(2);
      expect(creative!.fields.map(f => f.id)).toEqual(['genre', 'mood', 'visualStyle', 'targetAudience']);

      const production = groups.find(g => g.id === 'production');
      expect(production!.fields.map(f => f.id)).toEqual(['length', 'additionalNotes', 'projectFolder']);
    });

    it('should hide conditional groups when project type does not match', () => {
      const groups = buildFieldGroups(friendlyInputs, conditionalInputs, mockPorts, { projectType: 'Short Film' });
      expect(groups.find(g => g.id === 'tv')?.visible).toBe(false);
      expect(groups.find(g => g.id === 'commercial')?.visible).toBe(false);
    });

    it('should show TV group when project type is TV Pilot', () => {
      const groups = buildFieldGroups(friendlyInputs, conditionalInputs, mockPorts, { projectType: 'TV Pilot' });
      expect(groups.find(g => g.id === 'tv')?.visible).toBe(true);
      expect(groups.find(g => g.id === 'tv')?.label).toBe('TV Series Details');
    });

    it('should show commercial group when project type is Commercial', () => {
      const groups = buildFieldGroups(friendlyInputs, conditionalInputs, mockPorts, { projectType: 'Commercial' });
      expect(groups.find(g => g.id === 'commercial')?.visible).toBe(true);
      expect(groups.find(g => g.id === 'commercial')?.label).toBe('Commercial Details');
    });

    it('should use friendly labels instead of camelCase', () => {
      const groups = buildFieldGroups(friendlyInputs, null, mockPorts, {});
      const allFields = groups.flatMap(g => g.fields);
      expect(allFields.find(f => f.id === 'projectType')?.label).toBe('Project Type');
      expect(allFields.find(f => f.id === 'storyIdea')?.label).toBe('Story Idea');
    });

    it('should put uncategorized fields into Other group', () => {
      const extraInputs: FriendlyInput[] = [
        ...friendlyInputs,
        { id: 'customField', label: 'Custom', type: 'text', description: 'Custom' },
      ];
      const groups = buildFieldGroups(extraInputs, null, mockPorts, {});
      const other = groups.find(g => g.id === 'other');
      expect(other).toBeDefined();
      expect(other!.fields.map(f => f.id)).toEqual(['customField']);
    });
  });
});

// ── Integration: realistic pipeline-inputs.json ─────────────────

describe('Integration: full pipeline-inputs.json', () => {
  const realData = {
    friendlyInputs: [
      { id: 'projectFolder', label: 'Project Folder', type: 'text', required: true, description: 'Where to store files' },
      { id: 'projectType', label: 'Project Type', type: 'select', required: true, description: 'Project kind',
        options: [
          { value: 'Short Film', label: 'Short Film' },
          { value: 'TV Pilot', label: 'TV Pilot' },
          { value: 'Commercial', label: 'Commercial' },
        ] },
      { id: 'storyIdea', label: 'Story Idea', type: 'textarea', required: true, description: 'Story', rows: 4 },
      { id: 'title', label: 'Working Title', type: 'text', description: 'Title' },
      { id: 'genre', label: 'Genre', type: 'text', description: 'Genres' },
      { id: 'mood', label: 'Mood / Tone', type: 'text', description: 'Feel' },
      { id: 'targetAudience', label: 'Target Audience', type: 'text', description: 'Audience' },
      { id: 'visualStyle', label: 'Visual Style', type: 'text', description: 'Look' },
      { id: 'length', label: 'Approximate Length', type: 'text', description: 'Length' },
      { id: 'authorName', label: 'Your Name', type: 'text', description: 'Credits' },
      { id: 'additionalNotes', label: 'Additional Notes', type: 'textarea', description: 'Notes', rows: 3 },
    ],
    conditionalInputs: {
      tv: { showWhen: ['TV Pilot', 'TV Episode'], inputs: [
        { id: 'seriesName', label: 'Series Name', type: 'text', description: 'Series' },
      ] },
      commercial: { showWhen: ['Commercial'], inputs: [
        { id: 'brandName', label: 'Brand', type: 'text', description: 'Brand' },
      ] },
    },
  };

  it('should parse all 11 friendly inputs', () => {
    const result = parseFriendlyInputs(realData);
    expect(result.inputs).toHaveLength(11);
  });

  it('should build correct visible groups for Short Film', () => {
    const { inputs, conditional } = parseFriendlyInputs(realData);
    const groups = buildFieldGroups(inputs, conditional, [], { projectType: 'Short Film' });
    expect(groups.filter(g => g.visible).map(g => g.id)).toEqual(['essentials', 'creative', 'production']);
  });

  it('should build correct visible groups for TV Pilot', () => {
    const { inputs, conditional } = parseFriendlyInputs(realData);
    const groups = buildFieldGroups(inputs, conditional, [], { projectType: 'TV Pilot' });
    expect(groups.filter(g => g.visible).map(g => g.id)).toEqual(['essentials', 'creative', 'production', 'tv']);
  });

  it('should build correct visible groups for Commercial', () => {
    const { inputs, conditional } = parseFriendlyInputs(realData);
    const groups = buildFieldGroups(inputs, conditional, [], { projectType: 'Commercial' });
    expect(groups.filter(g => g.visible).map(g => g.id)).toEqual(['essentials', 'creative', 'production', 'commercial']);
  });
});
