import { Button, Input } from '@briefroom/ui';
import { useState } from 'react';
import { FormError } from './form-error.tsx';

export function CopyCommand({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  async function copy() {
    setFailed(false);
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setFailed(true);
    }
  }

  return (
    <div className="grid gap-2">
      <div className="flex gap-2">
        <Input aria-label={label} readOnly value={command} className="font-mono" />
        <Button type="button" variant="outline" onClick={copy}>
          Copy command
        </Button>
      </div>
      {copied ? (
        <p role="status" className="text-sm">
          Copied
        </p>
      ) : null}
      <FormError
        message={failed ? "Couldn't copy. Select the command and copy it by hand." : null}
      />
    </div>
  );
}
