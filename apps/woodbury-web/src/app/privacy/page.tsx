import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Privacy Policy — Woodbury',
  description: 'Privacy policy for the Woodbury Bridge Chrome extension and Woodbury desktop application.',
}

export default function PrivacyPage() {
  return (
    <main className="max-w-3xl mx-auto px-6 py-16">
      <h1 className="text-3xl font-bold mb-2">Privacy Policy</h1>
      <p className="text-sm text-gray-400 mb-8">Last updated: March 3, 2026</p>

      <p className="text-gray-300 mb-6 leading-relaxed">
        This privacy policy describes how the Woodbury Bridge Chrome extension and the
        Woodbury desktop application handle your data.
      </p>

      <Section title="What Woodbury Does">
        <p>
          Woodbury is a desktop automation platform. The Chrome extension (&quot;Woodbury Bridge&quot;)
          connects your browser to the Woodbury desktop app running on your computer. Together,
          they let you record browser interactions and replay them as automated workflows.
        </p>
      </Section>

      <Section title="Data Collection">
        <p>
          <strong>Woodbury does not collect, store, or transmit any personal data to external servers.</strong>
        </p>
        <ul className="list-disc pl-6 mt-3 space-y-2">
          <li>
            The Chrome extension communicates exclusively with a local WebSocket server
            on <code className="text-purple-400">localhost:7865</code>. No data leaves your machine.
          </li>
          <li>
            During workflow recording, the extension captures page snapshots (screenshots and
            element metadata) which are stored locally on your computer
            in <code className="text-purple-400">~/.woodbury/</code>.
          </li>
          <li>
            No analytics, telemetry, or tracking of any kind is included in the extension
            or the desktop app.
          </li>
          <li>
            No cookies are set or read by the extension beyond Chrome&apos;s built-in
            extension storage for maintaining connection state.
          </li>
        </ul>
      </Section>

      <Section title="Permissions Explained">
        <p>The Chrome extension requests the following permissions:</p>
        <ul className="list-disc pl-6 mt-3 space-y-2">
          <li>
            <strong>activeTab &amp; tabs</strong> — Required to interact with the currently
            active browser tab during workflow recording and replay.
          </li>
          <li>
            <strong>scripting</strong> — Injects a content script to query DOM elements
            and capture interactions on the page.
          </li>
          <li>
            <strong>debugger</strong> — Used solely to simulate mouse clicks and keyboard
            input during automated workflow replay. This is the only reliable way to
            drive browser interactions programmatically.
          </li>
          <li>
            <strong>storage</strong> — Persists extension connection state across browser
            restarts.
          </li>
          <li>
            <strong>downloads</strong> — Monitors download completion status during workflow
            steps that involve file downloads.
          </li>
          <li>
            <strong>alarms</strong> — Keeps the extension&apos;s background service worker
            alive to maintain the connection to the desktop app.
          </li>
          <li>
            <strong>sidePanel</strong> — Provides a debug panel for stepping through
            workflow execution.
          </li>
          <li>
            <strong>Host permissions (all URLs)</strong> — The extension must work on any
            website you want to automate. It does not access or modify pages unless you
            actively initiate a recording or workflow replay.
          </li>
        </ul>
      </Section>

      <Section title="Third-Party Services">
        <p>
          Woodbury does not integrate with or send data to any third-party analytics,
          advertising, or tracking services. The only network communication is the
          local WebSocket connection between the Chrome extension and the Woodbury
          desktop app on your own computer.
        </p>
      </Section>

      <Section title="Data Storage">
        <p>
          All data (workflow recordings, element snapshots, trained models) is stored
          locally on your computer in the <code className="text-purple-400">~/.woodbury/</code> directory.
          You can delete this directory at any time to remove all stored data.
        </p>
      </Section>

      <Section title="Changes to This Policy">
        <p>
          If this privacy policy is updated, the changes will be posted on this page
          with an updated date. Significant changes will be noted in the extension&apos;s
          release notes.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          For questions about this privacy policy, please open an issue on
          the <a href="https://github.com/Zachary-Companies/woodbury" className="text-purple-400 hover:text-purple-300 underline" target="_blank" rel="noopener noreferrer">Woodbury GitHub repository</a>.
        </p>
      </Section>
    </main>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-xl font-semibold mb-3 text-gray-100">{title}</h2>
      <div className="text-gray-300 leading-relaxed space-y-3">{children}</div>
    </section>
  )
}
