"use client";

import { useState, useRef, useCallback, KeyboardEvent } from "react";
import { Send, LayoutTemplate, Paperclip, X, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type MediaContentType = "image" | "video" | "audio" | "document";

interface PendingMedia {
  mediaId: string;
  mimeType: string;
  contentType: MediaContentType;
  filename: string;
  previewUrl?: string;
}

interface MessageComposerProps {
  conversationId: string;
  sessionExpired: boolean;
  onSend: (text: string) => void;
  onSendMedia: (
    type: MediaContentType,
    mediaId: string,
    mimeType: string,
    filename: string,
    caption?: string
  ) => void;
  onOpenTemplates: () => void;
}

export function MessageComposer({
  conversationId,
  sessionExpired,
  onSend,
  onSendMedia,
  onOpenTemplates,
}: MessageComposerProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pendingMedia, setPendingMedia] = useState<PendingMedia | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, []);

  const handleSend = useCallback(async () => {
    if (sending || uploading || sessionExpired) return;

    setSending(true);
    try {
      if (pendingMedia) {
        onSendMedia(
          pendingMedia.contentType,
          pendingMedia.mediaId,
          pendingMedia.mimeType,
          pendingMedia.filename,
          text.trim() || undefined
        );
        setPendingMedia(null);
        setText("");
        if (textareaRef.current) textareaRef.current.style.height = "auto";
        return;
      }

      const trimmed = text.trim();
      if (!trimmed) return;
      onSend(trimmed);
      setText("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    } finally {
      setSending(false);
    }
  }, [text, sending, uploading, sessionExpired, pendingMedia, onSend, onSendMedia]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value);
      adjustHeight();
    },
    [adjustHeight]
  );

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!e.target.files) return;
      // Reset so same file can be selected again
      e.target.value = "";
      if (!file) return;

      setUploading(true);
      try {
        const form = new FormData();
        form.append("file", file);

        const res = await fetch("/api/whatsapp/upload", {
          method: "POST",
          body: form,
        });

        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          toast.error(payload?.error || "Upload failed");
          return;
        }

        const previewUrl =
          payload.content_type === "image"
            ? URL.createObjectURL(file)
            : undefined;

        setPendingMedia({
          mediaId: payload.media_id,
          mimeType: payload.mime_type,
          contentType: payload.content_type,
          filename: payload.filename,
          previewUrl,
        });
      } catch {
        toast.error("Upload failed");
      } finally {
        setUploading(false);
      }
    },
    []
  );

  const canSend =
    !sessionExpired &&
    !sending &&
    !uploading &&
    (pendingMedia !== null || text.trim().length > 0);

  return (
    <div className="border-t border-slate-800 bg-slate-900 p-3">
      {sessionExpired && (
        <div className="mb-2 flex items-center justify-between rounded-lg bg-amber-500/10 px-3 py-2">
          <p className="text-xs text-amber-400">
            24-hour session expired. Use a template to re-engage.
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-amber-400 hover:text-amber-300"
            onClick={onOpenTemplates}
          >
            <LayoutTemplate className="mr-1 h-3 w-3" />
            Templates
          </Button>
        </div>
      )}

      {/* Media preview */}
      {pendingMedia && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 p-2">
          {pendingMedia.previewUrl ? (
            <img
              src={pendingMedia.previewUrl}
              alt="preview"
              className="h-12 w-12 rounded object-cover"
            />
          ) : (
            <div className="flex h-12 w-12 items-center justify-center rounded bg-slate-700">
              <FileText className="h-5 w-5 text-slate-400" />
            </div>
          )}
          <span className="flex-1 truncate text-xs text-slate-300">
            {pendingMedia.filename}
          </span>
          <button
            type="button"
            className="text-slate-500 hover:text-white"
            onClick={() => setPendingMedia(null)}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="flex items-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-9 w-9 shrink-0 p-0 text-slate-400 hover:text-white"
          onClick={onOpenTemplates}
          title="Send template"
        >
          <LayoutTemplate className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="h-9 w-9 shrink-0 p-0 text-slate-400 hover:text-white"
          disabled={sessionExpired || uploading}
          onClick={() => fileInputRef.current?.click()}
          title={uploading ? "Uploading…" : "Attach file"}
        >
          {uploading ? (
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-violet-500 border-t-transparent" />
          ) : (
            <Paperclip className="h-4 w-4" />
          )}
        </Button>

        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept="image/*,video/mp4,video/3gpp,audio/aac,audio/mpeg,audio/ogg,audio/opus,application/pdf,.doc,.docx,.xls,.xlsx,.txt"
          onChange={handleFileSelect}
        />

        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={
            sessionExpired
              ? "Session expired - use a template"
              : pendingMedia
              ? "Add a caption (optional)…"
              : "Type a message… (Shift+Enter for new line)"
          }
          disabled={sessionExpired}
          rows={1}
          className={cn(
            "flex-1 resize-none rounded-xl border border-slate-700 bg-slate-800 px-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition-colors focus:border-violet-500/50",
            sessionExpired && "cursor-not-allowed opacity-50"
          )}
        />

        <Button
          size="sm"
          className="h-9 w-9 shrink-0 bg-violet-600 p-0 hover:bg-violet-500 disabled:opacity-40"
          disabled={!canSend}
          onClick={handleSend}
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>

      <p className="mt-1 pl-[88px] text-[10px] text-slate-600">
        Type &apos;/&apos; for quick replies
      </p>
    </div>
  );
}
