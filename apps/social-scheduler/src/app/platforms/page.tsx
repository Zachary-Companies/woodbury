import { listConnectors } from '@/lib/storage';
import { getPlatformIcon } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function PlatformsPage() {
  const connectors = await listConnectors();

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold mb-6">📱 Platforms</h1>

      <p className="text-muted text-sm mb-6">
        Platform connectors define how Woodbury posts to each social media site.
        Each connector has a posting-flow that the agent follows using browser automation.
      </p>

      {connectors.length === 0 ? (
        <div className="text-center py-12 bg-surface rounded-lg">
          <p className="text-muted text-lg mb-2">No platforms configured</p>
          <p className="text-muted/60 text-sm">
            Add connector JSON files to ~/.woodbury/social-scheduler/connectors/
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {connectors.map(c => (
            <div key={c.platform} className="bg-surface border border-border rounded-lg p-5">
              <div className="flex items-center gap-3 mb-3">
                <span className="text-2xl">{getPlatformIcon(c.platform)}</span>
                <div>
                  <h3 className="font-semibold">{c.displayName}</h3>
                  <a
                    href={c.baseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-secondary hover:underline"
                  >
                    {c.baseUrl}
                  </a>
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div>
                  <span className="text-muted text-xs">Max text</span>
                  <p className="font-medium">{c.maxTextLength} chars</p>
                </div>
                <div>
                  <span className="text-muted text-xs">Max images</span>
                  <p className="font-medium">{c.maxImages}</p>
                </div>
                <div>
                  <span className="text-muted text-xs">Formats</span>
                  <p className="font-medium">{c.imageFormats.join(', ')}</p>
                </div>
                <div>
                  <span className="text-muted text-xs">Image required</span>
                  <p className="font-medium">{c.requiresImage ? 'Yes' : 'No'}</p>
                </div>
              </div>

              {/* Capabilities */}
              <div className="mt-3 flex gap-2">
                {Object.entries(c.capabilities).map(([cap, supported]) => (
                  <span
                    key={cap}
                    className={`text-xs px-2 py-0.5 rounded-full ${
                      supported
                        ? 'bg-success/20 text-success'
                        : 'bg-muted/10 text-muted/40'
                    }`}
                  >
                    {cap}
                  </span>
                ))}
              </div>

              {c.notes && (
                <p className="mt-3 text-xs text-muted italic">{c.notes}</p>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mt-8 bg-surface border border-border rounded-lg p-4">
        <h3 className="text-sm font-medium mb-2">Adding a Platform</h3>
        <ol className="text-xs text-muted space-y-1 list-decimal list-inside">
          <li>Create a connector JSON in ~/.woodbury/social-scheduler/connectors/</li>
          <li>Add site-knowledge markdown files in the extension&apos;s site-knowledge/ directory</li>
          <li>Write a posting-flow.md with step-by-step automation instructions</li>
          <li>Tell Woodbury: &quot;research the [platform] UI and document the posting flow&quot;</li>
        </ol>
      </div>
    </div>
  );
}
