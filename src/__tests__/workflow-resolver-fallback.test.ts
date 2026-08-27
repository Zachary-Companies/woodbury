/**
 * Tests for ElementResolver's fallback chain, focused on the percentage
 * last-resort and hover discovery.
 *
 * Two regressions motivated these:
 *  - `allowPercentage` was flipped to default false, which silently removed the
 *    positional last resort from every caller that didn't opt in.
 *  - hover discovery guarded with `!eb?.pctX`, so an element recorded at 0%
 *    (flush against a viewport edge) was treated as having no bounds at all.
 */

import { ElementResolver, AccessibilityResolver } from '../workflow/resolver';
import type { ElementTarget } from '../workflow/types';

/** Bridge that finds nothing — forces the chain to its last resort. */
function emptyBridge(overrides: Record<string, unknown> = {}) {
  const send = jest.fn(async (action: string) => {
    if (action === 'get_page_info') return { viewport: { width: 1000, height: 800 } };
    if (action in overrides) return overrides[action];
    return { elements: [] };
  });
  return { send } as any;
}

const BOUNDS = { pctX: 50, pctY: 25, pctW: 10, pctH: 5, viewportW: 1000, viewportH: 800 };

describe('ElementResolver percentage fallback', () => {
  const target: ElementTarget = {
    selector: '#gone',
    description: 'a button that no longer matches',
    expectedBounds: BOUNDS,
  } as ElementTarget;

  it('uses the recorded percentage position by default', async () => {
    // Callers that pass no options must keep the behaviour they had before the
    // allowPercentage flag existed, or every recorded workflow that relied on
    // the positional last resort starts throwing.
    const resolver = new ElementResolver(emptyBridge());
    const resolved = await resolver.resolve(target);

    expect(resolved.matchedBy).toBe('percentage');
    expect(resolved.position).toEqual({ left: 450, top: 180, width: 100, height: 40 });
  });

  it('throws instead of using percentage when the caller opts out', async () => {
    const resolver = new ElementResolver(emptyBridge());
    await expect(resolver.resolve(target, { allowPercentage: false })).rejects.toThrow(
      /Element not found/
    );
  });

  it('still throws with allowPercentage when there are no recorded bounds', async () => {
    const resolver = new ElementResolver(emptyBridge());
    await expect(
      resolver.resolve({ selector: '#gone' } as ElementTarget, { allowPercentage: true })
    ).rejects.toThrow(/Element not found/);
  });

  it('prefers a real match over the percentage fallback', async () => {
    const resolver = new ElementResolver(
      emptyBridge({
        find_elements: {
          elements: [{ position: { left: 10, top: 20, width: 30, height: 40 } }],
        },
      })
    );

    const resolved = await resolver.resolve(target);
    expect(resolved.matchedBy).toBe('selector');
    expect(resolved.position).toEqual({ left: 10, top: 20, width: 30, height: 40 });
  });
});

describe('AccessibilityResolver percentage fallback', () => {
  const target: ElementTarget = {
    ariaLabel: 'Missing',
    expectedBounds: BOUNDS,
  } as ElementTarget;

  it('honors allowPercentage rather than ignoring it', async () => {
    // This resolver used to accept the option and discard it, so the two
    // resolvers disagreed about whether percentages were permitted.
    const resolver = new AccessibilityResolver(emptyBridge());

    const withPct = await resolver.resolve(target);
    expect(withPct.matchedBy).toBe('percentage');

    await expect(resolver.resolve(target, { allowPercentage: false })).rejects.toThrow(
      /Element not found/
    );
  });
});

describe('hover discovery', () => {
  /** pctX/pctY of 0 is a real position (an element flush against an edge). */
  const edgeTarget: ElementTarget = {
    selector: '#hidden-until-hover',
    expectedBounds: { pctX: 0, pctY: 0, pctW: 4, pctH: 4, viewportW: 1000, viewportH: 800 },
  } as ElementTarget;

  it('probes for an element recorded at 0%, 0%', async () => {
    const hover = jest.fn(async (_x: number, _y: number) => {});
    const sleep = jest.fn(async (_ms: number) => {});

    // The element only becomes findable once hovered.
    let hovered = false;
    const bridge = {
      send: jest.fn(async (action: string) => {
        if (action === 'get_page_info') return { viewport: { width: 1000, height: 800 } };
        if (action === 'find_elements' && hovered) {
          return { elements: [{ position: { left: 0, top: 0, width: 40, height: 32 } }] };
        }
        return { elements: [] };
      }),
    } as any;

    const resolver = new ElementResolver(bridge);
    const result = await resolver.resolveWithHoverDiscovery(
      edgeTarget,
      async (x: number, y: number) => {
        hovered = true;
        await hover(x, y);
      },
      sleep
    );

    expect(hover).toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result!.matchedBy).toBe('selector');
  });

  it('returns null when bounds are genuinely absent', async () => {
    const resolver = new ElementResolver(emptyBridge());
    const result = await resolver.resolveWithHoverDiscovery(
      { selector: '#x' } as ElementTarget,
      async () => {},
      async () => {}
    );
    expect(result).toBeNull();
  });

  it('gives up after exhausting its probes', async () => {
    const hover = jest.fn(async (_x: number, _y: number) => {});
    const resolver = new ElementResolver(emptyBridge());

    const result = await resolver.resolveWithHoverDiscovery(edgeTarget, hover, async () => {});

    expect(result).toBeNull();
    expect(hover.mock.calls.length).toBeGreaterThan(1); // probed several offsets
  });

  it('never reports a percentage match as a hover-discovery success', async () => {
    // The probe loop rejects results whose matchedBy is 'percentage'; if the
    // internal re-resolve were allowed to fall back to percentage it would
    // always "succeed" on the first probe and report a bogus hit.
    const resolver = new ElementResolver(emptyBridge());
    const result = await resolver.resolveWithHoverDiscovery(
      edgeTarget,
      async () => {},
      async () => {}
    );
    expect(result).toBeNull();
  });
});
