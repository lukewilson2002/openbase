import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { User } from "@/api/types";
import { errorMessage } from "@/api/client";
import { Notice, Section } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { browserTimeZone, listTimeZones } from "@/lib/format";

export function ProfileSection({ user }: { user: User }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const zones = useMemo(() => listTimeZones(), []);
  const [name, setName] = useState(user.name);
  // "" = follow the browser's zone (the API treats an empty string as "clear").
  const [timezone, setTimezone] = useState(user.timezone ?? "");

  const save = useMutation({
    mutationFn: () => api.auth.updateMe({ name: name.trim(), timezone }),
    onSuccess: (updated) => {
      qc.setQueryData(keys.me, updated);
      toast({ title: "Profile saved", variant: "success" });
    },
  });
  const dirty = name.trim() !== user.name || timezone !== (user.timezone ?? "");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <Section title="Profile" description="How you appear to other people, and how dates are shown to you.">
      <form onSubmit={submit} className="flex max-w-md flex-col gap-4">
        {save.isError && <Notice tone="error">{errorMessage(save.error)}</Notice>}
        <Field label="Email" hint="Your email is your login and cannot be changed here.">
          {(ctl) => <Input {...ctl} value={user.email} readOnly disabled />}
        </Field>
        <Field label="Name">{(ctl) => <Input {...ctl} value={name} onChange={(e) => setName(e.target.value)} required />}</Field>
        <Field label="Time zone" hint="Used for relative dates such as Today in filters.">
          {(ctl) => (
            <Select {...ctl} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              <option value="">Browser default ({browserTimeZone()})</option>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || !name.trim()}>
            Save changes
          </Button>
        </div>
      </form>
    </Section>
  );
}
