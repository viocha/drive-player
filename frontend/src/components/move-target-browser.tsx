import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, File, Folder } from "lucide-react";
import type { FileEntry } from "../../bindings/drive-player";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/components/ui/toast";
import { TruncatedName } from "@/components/truncated-name";

export type BrowseMoveDirectory = (accountID: string, path: string, signal: AbortSignal) => Promise<FileEntry[]>;
export type MoveTarget = { path: string; loading: boolean };

export function MoveTargetBrowser({ accountID, source, isMobile, titleLines, initialEntries, disabled, browseDirectory, onChange }: {
  accountID: string; source: FileEntry; isMobile: boolean; titleLines: number; initialEntries?: FileEntry[]; disabled: boolean;
  browseDirectory: BrowseMoveDirectory; onChange: (target: MoveTarget) => void;
}) {
  const initial = useRef({ path: source.path.slice(0, source.path.lastIndexOf("/")) || "/", entries: initialEntries }).current;
  const initialPath = initial.path;
  const [directory, setDirectory] = useState({ path: initialPath, entries: initial.entries ?? [] });
  const [loading, setLoading] = useState(!initial.entries);
  const request = useRef<AbortController | null>(null);
  const currentPath = useRef(initialPath);
  const viewport = useRef<HTMLDivElement>(null);
  const pathBar = useRef<HTMLElement>(null);
  const navigate = useCallback(async (path: string) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    onChange({ path, loading: true });
    try {
      const entries = await browseDirectory(accountID, path, controller.signal);
      if (controller.signal.aborted) return;
      currentPath.current = path;
      setDirectory({ path, entries });
      onChange({ path, loading: false });
    } catch (error) {
      if (controller.signal.aborted) return;
      toast.add({ title: "读取目录失败", description: String(error), type: "error" });
      onChange({ path: currentPath.current, loading: false });
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [accountID, browseDirectory, onChange]);

  useEffect(() => {
    if (!initial.entries) void navigate(initialPath);
    return () => request.current?.abort();
  }, [initial, initialPath, navigate]);

  useLayoutEffect(() => {
    if (viewport.current) viewport.current.scrollTop = 0;
    if (pathBar.current) pathBar.current.scrollLeft = pathBar.current.scrollWidth;
  }, [directory.path]);

  const parts = directory.path.split("/").filter(Boolean);
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    <Separator />
    <div className="flex min-w-0 items-center gap-2 px-3 py-2 sm:px-4">
      {!isMobile && <Button type="button" variant="outline" size="icon" aria-label="上级目录" disabled={disabled || loading || directory.path === "/"} onClick={() => void navigate(directory.path.slice(0, directory.path.lastIndexOf("/")) || "/")}><ArrowUp /></Button>}
      <Breadcrumb ref={pathBar} aria-label="目标路径" className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden px-1">
        <BreadcrumbList className="w-max flex-nowrap whitespace-nowrap">
          <BreadcrumbItem>{directory.path === "/" ? <BreadcrumbPage>根目录</BreadcrumbPage> : <BreadcrumbLink render={<button type="button" disabled={disabled || loading} />} onClick={() => void navigate("/")}>根目录</BreadcrumbLink>}</BreadcrumbItem>
          {parts.map((name, index) => <Fragment key={index}>
            <BreadcrumbSeparator />
            <BreadcrumbItem>{index === parts.length - 1 ? <BreadcrumbPage>{name}</BreadcrumbPage> : <BreadcrumbLink render={<button type="button" disabled={disabled || loading} />} onClick={() => void navigate("/" + parts.slice(0, index + 1).join("/"))}>{name}</BreadcrumbLink>}</BreadcrumbItem>
          </Fragment>)}
        </BreadcrumbList>
      </Breadcrumb>
    </div>
    <Separator />
    <div className="relative min-h-0 min-w-0 flex-1" aria-label="目标目录内容" aria-busy={loading}>
    <ScrollArea viewportRef={viewport} className="h-full min-w-0">
      <div className="flex min-h-full min-w-0 flex-col">
        {!loading && directory.entries.map((entry) => <Button key={entry.path} type="button" variant="ghost" className="h-auto w-full min-w-0 justify-start gap-2 rounded-none px-3 py-2 sm:gap-3 sm:px-4" disabled={disabled || !entry.isDirectory || entry.path === source.path || entry.path.startsWith(source.path + "/")} onClick={() => void navigate(entry.path)}>
          <span className="flex size-6 shrink-0 items-center justify-center">{entry.isDirectory ? <Folder className="size-5" /> : <File className="size-5" />}</span>
          <span className="min-w-0 flex-1 text-left"><TruncatedName name={entry.name} lines={titleLines} /></span>
        </Button>)}
      </div>
    </ScrollArea>
    {(loading || directory.entries.length === 0) && <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">{loading ? <Spinner aria-label="正在读取目录" className="size-5" /> : "当前目录为空"}</div>}
    </div>
  </div>;
}
