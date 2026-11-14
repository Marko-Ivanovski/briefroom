import type { ToolLinkInput } from '@briefroom/contracts';
import { Button, Label } from '@briefroom/ui';
import { useState, type FormEvent } from 'react';
import { Field } from './field.tsx';
import { FormError } from './form-error.tsx';

export interface ProjectFormValues {
  name: string;
  client: string;
  summary: string;
  repoRemotes: string[];
  toolLinks: ToolLinkInput[];
}

export const EMPTY_PROJECT_FORM: ProjectFormValues = {
  name: '',
  client: '',
  summary: '',
  repoRemotes: [],
  toolLinks: [],
};

interface ProjectFormProps {
  initial?: ProjectFormValues;
  submitLabel: string;
  pending: boolean;
  error: string | null;
  onSubmit: (values: ProjectFormValues) => void;
  onCancel?: () => void;
}

export function ProjectForm({
  initial = EMPTY_PROJECT_FORM,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
}: ProjectFormProps) {
  const [name, setName] = useState(initial.name);
  const [client, setClient] = useState(initial.client);
  const [summary, setSummary] = useState(initial.summary);
  const [remotes, setRemotes] = useState(initial.repoRemotes);
  const [links, setLinks] = useState(initial.toolLinks);

  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit({
      name,
      client,
      summary,
      repoRemotes: remotes.map((r) => r.trim()).filter((r) => r !== ''),
      toolLinks: links,
    });
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <Field
        id="project-name"
        label="Name"
        value={name}
        required
        maxLength={80}
        onChange={(e) => setName(e.target.value)}
      />
      <Field
        id="project-client"
        label="Client"
        value={client}
        maxLength={80}
        onChange={(e) => setClient(e.target.value)}
      />
      <div className="grid gap-2">
        <Label htmlFor="project-summary">Summary</Label>
        <textarea
          id="project-summary"
          value={summary}
          maxLength={500}
          rows={3}
          onChange={(e) => setSummary(e.target.value)}
          className="border-input focus-visible:border-ring focus-visible:ring-ring/50 rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px]"
        />
      </div>

      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-medium">Repo remotes</legend>
        {remotes.map((remote, i) => (
          <div key={i} className="flex items-end gap-2">
            <div className="flex-1">
              <Field
                id={`remote-${i}`}
                label={`Repo remote ${i + 1}`}
                value={remote}
                maxLength={500}
                onChange={(e) => setRemotes(remotes.map((r, j) => (j === i ? e.target.value : r)))}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              aria-label={`Remove remote ${i + 1}`}
              onClick={() => setRemotes(remotes.filter((_, j) => j !== i))}
            >
              Remove
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() => setRemotes([...remotes, ''])}
        >
          Add repo remote
        </Button>
      </fieldset>

      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-medium">Tool links</legend>
        {links.map((link, i) => (
          <div key={i} className="flex items-end gap-2">
            <div className="w-40">
              <Field
                id={`link-label-${i}`}
                label={`Tool link ${i + 1} label`}
                value={link.label}
                required
                maxLength={40}
                onChange={(e) =>
                  setLinks(links.map((l, j) => (j === i ? { ...l, label: e.target.value } : l)))
                }
              />
            </div>
            <div className="flex-1">
              <Field
                id={`link-url-${i}`}
                label={`Tool link ${i + 1} URL`}
                type="url"
                value={link.url}
                required
                maxLength={2000}
                onChange={(e) =>
                  setLinks(links.map((l, j) => (j === i ? { ...l, url: e.target.value } : l)))
                }
              />
            </div>
            <Button
              type="button"
              variant="outline"
              aria-label={`Remove link ${i + 1}`}
              onClick={() => setLinks(links.filter((_, j) => j !== i))}
            >
              Remove
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() => setLinks([...links, { label: '', url: '' }])}
        >
          Add tool link
        </Button>
      </fieldset>

      <FormError message={error} />
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
