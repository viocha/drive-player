import { useRef, type ReactElement } from "react";
import { Clipboard } from "@wailsio/runtime";
import { Copy, FolderInput, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { AppService, type FileEntry } from "../../bindings/drive-player";
import { ContextMenu, ContextMenuContent, ContextMenuGroup, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { toast } from "@/components/ui/toast";

export function FileActionsMenu({ entry, accountID, children, onOpenChange, onCloseComplete, onAction, onRefreshMetadata, onRefreshCover, refreshingMetadata, refreshingCover }: {
  entry: FileEntry; accountID: string; children: ReactElement;
  onOpenChange: (open: boolean) => void;
  onCloseComplete: () => void;
  onAction: (kind: "rename" | "move" | "delete") => void;
  onRefreshMetadata?: () => void; onRefreshCover?: () => void;
  refreshingMetadata: boolean; refreshingCover: boolean;
}) {
  const pendingAction = useRef<(() => void) | null>(null);
  async function copyLink(credentials: boolean) {
    try {
      const link = await AppService.GetFileLink(accountID, entry.path, credentials);
      await Clipboard.SetText(link);
      toast.add({ title: "已复制链接", type: "success" });
    } catch (error) {
      toast.add({ title: "复制失败", description: String(error), type: "error" });
    }
  }
  return <ContextMenu onOpenChange={onOpenChange} onOpenChangeComplete={(open) => {
    if (open) return;
    onCloseComplete();
    const action = pendingAction.current;
    pendingAction.current = null;
    action?.();
  }}>
    <ContextMenuTrigger render={children} />
    <ContextMenuContent>
      <ContextMenuGroup>
        <ContextMenuItem onClick={() => void copyLink(false)}><Copy />复制链接</ContextMenuItem>
        <ContextMenuItem onClick={() => void copyLink(true)}><Copy />复制链接（含凭据）</ContextMenuItem>
      </ContextMenuGroup>
      {onRefreshMetadata && <>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem disabled={refreshingMetadata} onClick={onRefreshMetadata}><RefreshCw />刷新元信息</ContextMenuItem>
          <ContextMenuItem disabled={refreshingCover} onClick={onRefreshCover}><RefreshCw />刷新封面</ContextMenuItem>
        </ContextMenuGroup>
      </>}
      <ContextMenuSeparator />
      <ContextMenuGroup>
        <ContextMenuItem onClick={() => { pendingAction.current = () => onAction("rename"); }}><Pencil />重命名</ContextMenuItem>
        <ContextMenuItem onClick={() => { pendingAction.current = () => onAction("move"); }}><FolderInput />移动</ContextMenuItem>
        <ContextMenuItem variant="destructive" onClick={() => { pendingAction.current = () => onAction("delete"); }}><Trash2 />删除</ContextMenuItem>
      </ContextMenuGroup>
    </ContextMenuContent>
  </ContextMenu>;
}
