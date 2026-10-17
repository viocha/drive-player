import { useEffect, useState } from "react";
import { AppService, type AppState } from "../../bindings/drive-player";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { Input } from "@/components/ui/input";

const options = [1, 2, 3].map((value) => ({ value, label: `${value} 行` }));
const previewOptions = [{ value: 0, label: "关闭" }, ...[320, 480, 640].map((value) => ({ value, label: `${value} px` }))];

export function TitleLinesSettings({ value, previewWidth, previewDelayMS, isMobile, onSave }: { value: number; previewWidth: number; previewDelayMS: number; isMobile: boolean; onSave: (state: AppState) => void }) {
  const [saving, setSaving] = useState(false);
  const [savingPreview, setSavingPreview] = useState(false);
  const [delayInput, setDelayInput] = useState(String(previewDelayMS));
  const [savingDelay, setSavingDelay] = useState(false);
  useEffect(() => setDelayInput(String(previewDelayMS)), [previewDelayMS]);
  const save = async (lines: number | null) => {
    if (lines === null || lines === value || saving) return;
    setSaving(true);
    try { onSave(await AppService.SetTitleLines(lines)); }
    catch (error) { toast.add({ title: "保存失败", description: String(error), type: "error" }); }
    finally { setSaving(false); }
  };
  const savePreview = async (width: number | null) => {
    if (width === null || width === previewWidth || savingPreview) return;
    setSavingPreview(true);
    try { onSave(await AppService.SetCoverPreviewWidth(width)); }
    catch (error) { toast.add({ title: "保存失败", description: String(error), type: "error" }); }
    finally { setSavingPreview(false); }
  };
  const saveDelay = async (input: string) => {
    if (savingDelay || input === String(previewDelayMS)) return;
    const delayMS = Number(input);
    if (!input.trim() || !Number.isInteger(delayMS) || delayMS < 0 || delayMS > 5000) {
      toast.add({ title: "设置无效", description: "延迟必须在 0 到 5000 毫秒之间", type: "error" });
      setDelayInput(String(previewDelayMS));
      return;
    }
    setSavingDelay(true);
    try { onSave(await AppService.SetCoverPreviewDelay(delayMS)); setDelayInput(String(delayMS)); }
    catch (error) { toast.add({ title: "保存失败", description: String(error), type: "error" }); setDelayInput(String(previewDelayMS)); }
    finally { setSavingDelay(false); }
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
        {!isMobile && <>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="cover-preview-width">封面悬浮预览</FieldLabel>
            <Select items={previewOptions} value={previewWidth} disabled={savingPreview} onValueChange={(width) => void savePreview(width)}>
              <SelectTrigger id="cover-preview-width" className="w-24"><SelectValue /></SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>{previewOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="cover-preview-delay">封面预览延迟（毫秒）</FieldLabel>
            <Input id="cover-preview-delay" className="w-24" type="number" min={0} max={5000} step={50} value={delayInput} disabled={savingDelay} onChange={(event) => setDelayInput(event.target.value)} onBlur={(event) => void saveDelay(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} />
          </Field>
        </>}
      </FieldGroup>
    </CardContent>
  </Card>;
}
