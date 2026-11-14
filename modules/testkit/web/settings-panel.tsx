import type { ModuleSettingsPanelProps } from '@briefroom/module-kit/web';
import { useState } from 'react';

export function TestkitSettingsPanel({ settings, canEdit, save }: ModuleSettingsPanelProps) {
  const saved = typeof settings.greeting === 'string' ? settings.greeting : '';
  const [draft, setDraft] = useState(saved);
  return (
    <div>
      <p>Testkit settings panel</p>
      <label>
        Greeting
        <input
          value={draft}
          disabled={!canEdit}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={40}
        />
      </label>
      {canEdit ? (
        <button type="button" onClick={() => void save({ greeting: draft })}>
          Save greeting
        </button>
      ) : null}
    </div>
  );
}
