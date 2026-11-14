import { Input, Label } from '@briefroom/ui';
import type { ComponentProps } from 'react';

interface FieldProps extends Omit<ComponentProps<typeof Input>, 'id'> {
  id: string;
  label: string;
}

export function Field({ id, label, ...input }: FieldProps) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...input} />
    </div>
  );
}
