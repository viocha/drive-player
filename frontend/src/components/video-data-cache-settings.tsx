import { useEffect, useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import { AppService, type AppState, type VideoDataCacheStats } from "../../bindings/drive-player";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/components/ui/toast";

export function VideoDataCacheSettings({ maxAgeMinutes, maxSizeMB, onSave }: {
  maxAgeMinutes: number;
  maxSizeMB: number;
  onSave: (state: AppState) => void;
}) {
  const [age, setAge] = useState(String(maxAgeMinutes));
  const [size, setSize] = useState(String(maxSizeMB));
  const [stats, setStats] = useState<VideoDataCacheStats>({ count: 0, totalBytes: 0 });
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  useEffect(() => { setAge(String(maxAgeMinutes)); setSize(String(maxSizeMB)); }, [maxAgeMinutes, maxSizeMB]);
  useEffect(() => {
    const request = AppService.GetVideoDataCacheStats();
    let active = true;
    void request.then((value) => { if (active) setStats(value); }).catch((error) => {
      if (active) toast.add({ title: "读取缓存失败", description: String(error), type: "error" });
    });
    return () => { active = false; request.cancel(); };
  }, []);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const minutes = Number(age), megabytes = Number(size);
    if (!age.trim() || !Number.isInteger(minutes) || minutes < 1 || minutes > 10080) {
      toast.add({ title: "设置无效", description: "视频数据保留时间必须在 1 到 10080 分钟之间", type: "error" }); return;
    }
    if (!size.trim() || !Number.isInteger(megabytes) || megabytes < 0 || megabytes > 10240) {
      toast.add({ title: "设置无效", description: "视频数据缓存上限必须在 0 到 10240 MB 之间", type: "error" }); return;
    }
    setSaving(true);
    try {
      onSave(await AppService.SetVideoDataSettings(minutes, megabytes));
      setStats(await AppService.GetVideoDataCacheStats());
    } catch (error) { toast.add({ title: "保存失败", description: String(error), type: "error" }); }
    finally { setSaving(false); }
  };
  const clear = async () => {
    setClearing(true);
    try { setStats(await AppService.ClearVideoDataCache()); }
    catch (error) { toast.add({ title: "清空失败", description: String(error), type: "error" }); }
    finally { setClearing(false); }
  };
  const usage = stats.totalBytes === 0 ? "0 B" : stats.totalBytes < 1024 * 1024 ? `${(stats.totalBytes / 1024).toFixed(1)} KB` : `${(stats.totalBytes / (1024 * 1024)).toFixed(1)} MB`;
  return <Card>
    <CardHeader><CardTitle>视频数据缓存</CardTitle></CardHeader>
    <CardContent className="flex flex-col gap-4">
      <form onSubmit={(event) => void save(event)} className="flex flex-col gap-4">
        <FieldGroup className="grid sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="video-data-max-age">最长保留时间（分钟）</FieldLabel>
            <Input id="video-data-max-age" type="number" min={1} max={10080} value={age} onChange={(event) => setAge(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="video-data-max-size">总大小上限（MB）</FieldLabel>
            <Input id="video-data-max-size" type="number" min={0} max={10240} value={size} onChange={(event) => setSize(event.target.value)} />
          </Field>
        </FieldGroup>
        <Button type="submit" className="self-start" disabled={saving || Number(age) === maxAgeMinutes && Number(size) === maxSizeMB}>保存</Button>
      </form>
      <Separator />
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>空间占用</span><Badge variant="outline">{usage} / {maxSizeMB} MB</Badge><Badge variant="outline">{stats.count} 个视频</Badge>
        </div>
        <Button variant="outline" size="sm" onClick={() => void clear()} disabled={clearing || stats.totalBytes === 0}><Trash2 data-icon="inline-start" />清空</Button>
      </div>
    </CardContent>
  </Card>;
}
