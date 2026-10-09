import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import JevSettings from '../../../src/renderer/components/Settings/JevSettings';
import Button from '../../../src/renderer/components/ui/Button';
import Input from '../../../src/renderer/components/ui/Input';
import Select from '../../../src/renderer/components/ui/Select';
import { SettingRow, SettingsSection } from '../../../src/renderer/components/Settings/SettingsLayout';
import type { JevConfigurePatch } from '../../../src/shared/jev';
import '../../../src/renderer/styles/globals.css';
import '../../../src/renderer/styles/ui.css';
import './style.css';

async function request(path: string, body?: unknown) {
  const response = await fetch(`/api/${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('Synthetic bridge request failed');
  return response.json();
}

// A test-only loopback bridge replaces Electron IPC. JevSettings itself and
// its shared UI primitives are imported unchanged from production.
Object.assign(window, { electronAPI: { deck: { jev: {
  status: () => request('status'),
  configure: (patch: JevConfigurePatch) => request('configure', patch),
} } } });

function Harness() {
  const [text, setText] = useState('Fleet status');
  const [scenario, setScenario] = useState('valid');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (busy) return;
    setBusy(true);
    setAnswer('');
    try {
      await request('scenario', { scenario });
      const response = await request('send', { text });
      setAnswer(JSON.stringify(response, null, 2));
    } catch { setAnswer('Synthetic bridge failed'); }
    finally { setBusy(false); }
  };
  return (
    <main className="jev-harness">
      <h1>Jev settings browser harness</h1>
      <p>Real settings and routing code with a test-only loopback bridge. Only the built-in dummy key is accepted. Synthetic data only. This is not native Electron E2E.</p>
      <JevSettings />
      <SettingsSection title="Synthetic send controls">
        <SettingRow label="Question" layout="stacked">
          <Input aria-label="Synthetic question" value={text} onChange={(event) => setText(event.target.value)} />
        </SettingRow>
        <SettingRow label="Provider scenario">
          <Select aria-label="Synthetic scenario" value={scenario} onChange={(event) => setScenario(event.target.value)}>
            {['valid', 'error', 'timeout', 'malformed', 'stale'].map((value) => <option key={value}>{value}</option>)}
          </Select>
          <Button onClick={() => { void send(); }} disabled={busy}>Send synthetic question</Button>
        </SettingRow>
      </SettingsSection>
      <pre data-testid="synthetic-answer" aria-live="polite">{answer}</pre>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Harness root missing');
createRoot(root).render(<Harness />);
