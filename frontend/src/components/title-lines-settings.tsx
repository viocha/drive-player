import { useState } from "react";
import { AppService, type AppState } from "../../bindings/drive-player";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";

const options = [1, 2, 3].map((value) => ({ value, label: `${value} 行` }));

export function TitleLinesSettings({ value, onSave }: { value: number; onSave: (state: AppState) => void }) {
  const [saving, setSaving] = useState(false);
  const save = async (lines: number | null) => {
    if (lines === null || lines === value || saving) return;
    setSaving(true);
    try { onSave(await AppService.SetTitleLines(lines)); }
    catch (error) { toast.add({ title: "保存失败", description: String(error), type: "error" }); }
    finally { setSaving(false); }
  };
  return <Card>
    <CardHeader><CardTitle>显示</CardTitle></CardHeader>
    <CardContent>
      <FieldGroup>
        <Field orientation="horizontal">
          <FieldLabel htmlFor="title-lines">标题行数</FieldLabel>
          <Select items={options} value={value} disabled={saving} onValueChange={(lines) => void save(lines)}>
            <SelectTrigger id="title-lines" className="w-24"><SelectValue /></SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      </FieldGroup>
    </CardContent>
  </Card>;
}
