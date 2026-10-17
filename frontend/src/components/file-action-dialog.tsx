import { useImperativeHandle, useRef, useState, type FormEvent, type Ref } from "react";
import { AppService, type FileEntry } from "../../bindings/drive-player";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { toast } from "@/components/ui/toast";
import { MoveTargetBrowser, type BrowseMoveDirectory, type MoveTarget } from "@/components/move-target-browser";
import { TruncatedName } from "@/components/truncated-name";
import { cn } from "@/lib/utils";

export type FileAction = { kind: "rename" | "move" | "delete"; entry: FileEntry; accountID: string };
export type FileActionDialogHandle = { close: () => void };

export function FileActionDialog({ ref, action, initialEntries, isMobile, titleLines, browseDirectory, onClosed, onComplete }: {
  ref?: Ref<FileActionDialogHandle>;
  action: FileAction;
  initialEntries?: FileEntry[];
  isMobile: boolean;
  titleLines: number;
  browseDirectory: BrowseMoveDirectory;
  onClosed: () => void;
  onComplete: (action: FileAction, renamedPath?: string) => void;
}) {
  const dot = action.entry.isDirectory ? -1 : action.entry.name.lastIndexOf(".");
  const extension = dot > 0 ? action.entry.name.slice(dot) : "";
  const originalStem = extension ? action.entry.name.slice(0, -extension.length) : action.entry.name;
  const [stem, setStem] = useState(originalStem);
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const initialDirectory = action.entry.path.slice(0, action.entry.path.lastIndexOf("/")) || "/";
  const [target, setTarget] = useState<MoveTarget>({ path: initialDirectory, loading: !initialEntries });
  useImperativeHandle(ref, () => ({ close: () => { if (!submitting.current) setOpen(false); } }), []);
  const rename = action.kind === "rename";
  const move = action.kind === "move";
  const title = rename ? "重命名" : move ? "移动" : "删除";
  const valid = Boolean(stem.trim()) && stem !== "." && stem !== ".." && !/[/\\\p{Cc}]/u.test(stem);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || (rename && (!valid || stem === originalStem)) || (move && (target.loading || target.path === initialDirectory))) return;
    submitting.current = true;
    setBusy(true);
    try {
      const path = rename
        ? await AppService.RenameEntry(action.accountID, action.entry.path, stem, action.entry.isDirectory)
        : move ? await AppService.MoveEntry(action.accountID, action.entry.path, target.path)
          : (await AppService.DeleteEntry(action.accountID, action.entry.path), undefined);
      onComplete(action, path);
      setOpen(false);
    } catch (error) {
      toast.add({ title: `${title}失败`, description: String(error), type: "error" });
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return <Dialog open={open} onOpenChange={(value) => { if (!submitting.current) setOpen(value); }} onOpenChangeComplete={(value) => { if (!value) onClosed(); }}>
    <DialogContent initialFocus={rename ? nameInputRef : undefined} showCloseButton={!busy} className={move ? cn("flex min-h-0 flex-col gap-0 overflow-hidden p-0", isMobile ? "top-0 left-0 h-dvh w-screen max-w-none translate-x-0 translate-y-0 rounded-none sm:max-w-none" : "h-[min(44rem,calc(100dvh-2rem))] sm:max-w-3xl") : "sm:max-w-xl"}>
      <form onSubmit={(event) => void submit(event)} className={move ? "flex min-h-0 min-w-0 flex-1 flex-col" : "flex min-w-0 flex-col gap-4"}>
        <DialogHeader className={move ? "px-4 py-3 pr-12" : undefined}>
          <DialogTitle className={move ? "flex min-w-0 items-center leading-6" : undefined}>{move ? <><span className="shrink-0">移动：</span><TruncatedName name={action.entry.name} className="min-w-0" /></> : title}</DialogTitle>
          {action.kind === "delete" && <DialogDescription className="break-all">确定删除 {action.entry.name}？{action.entry.isDirectory ? "目录中的所有内容也会删除。" : ""}</DialogDescription>}
        </DialogHeader>
        {rename && <FieldGroup><Field>
          <FieldLabel htmlFor="entry-name">名称</FieldLabel>
          <InputGroup>
            <InputGroupInput ref={nameInputRef} id="entry-name" value={stem} onChange={(event) => setStem(event.target.value)} disabled={busy} onFocus={(event) => event.target.select()} />
            {extension && <InputGroupAddon align="inline-end"><InputGroupText>{extension}</InputGroupText></InputGroupAddon>}
          </InputGroup>
        </Field></FieldGroup>}
        {move && <MoveTargetBrowser accountID={action.accountID} source={action.entry} isMobile={isMobile} titleLines={titleLines} initialEntries={initialEntries} disabled={busy} browseDirectory={browseDirectory} onChange={setTarget} />}
        <DialogFooter className={move ? "m-0 flex-row justify-end rounded-none" : undefined}>
          <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>取消</Button>
          <Button type="submit" variant={action.kind === "delete" ? "destructive" : "default"} disabled={busy || (rename && (!valid || stem === originalStem)) || (move && (target.loading || target.path === initialDirectory))}>{rename ? "保存" : title}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
