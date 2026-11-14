import type { AvailableModule } from '@briefroom/contracts';
import { Label } from '@briefroom/ui';
import { useState } from 'react';

// Every module starts selected, so the state holds only what the user switched off.
export function useStartingModules(available: AvailableModule[]) {
  const [off, setOff] = useState<string[]>([]);
  return {
    selected: available.filter((m) => !off.includes(m.id)).map((m) => m.id),
    toggle: (id: string, on: boolean) =>
      setOff((current) => (on ? current.filter((x) => x !== id) : [...current, id])),
  };
}

interface StartingModulesProps {
  available: AvailableModule[];
  selected: string[];
  onToggle: (id: string, on: boolean) => void;
}

export function StartingModules({ available, selected, onToggle }: StartingModulesProps) {
  if (available.length === 0) return null;
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">Starting modules</legend>
      {available.map((m) => (
        <div key={m.id} className="flex items-start gap-2">
          <input
            id={`starting-module-${m.id}`}
            type="checkbox"
            className="mt-1 size-4"
            checked={selected.includes(m.id)}
            onChange={(e) => onToggle(m.id, e.target.checked)}
          />
          <div className="grid gap-0.5">
            <Label htmlFor={`starting-module-${m.id}`}>{m.name}</Label>
            <p className="text-muted-foreground text-xs">{m.description}</p>
          </div>
        </div>
      ))}
    </fieldset>
  );
}
