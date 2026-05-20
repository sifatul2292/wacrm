'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import type { Contact, MessageTemplate } from '@/types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Search, MessageSquare, LayoutTemplate, X } from 'lucide-react';

interface NewConversationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type MessageMode = 'text' | 'template';

function extractParams(body: string): number[] {
  const ids = new Set<number>();
  for (const m of body.matchAll(/\{\{(\d+)\}\}/g)) ids.add(Number(m[1]));
  return Array.from(ids).sort((a, b) => a - b);
}

function renderPreview(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, n) => {
    const v = params[Number(n) - 1];
    return v?.trim() ? v : `{{${n}}}`;
  });
}

export function NewConversationModal({ open, onOpenChange }: NewConversationModalProps) {
  const router = useRouter();
  const supabase = createClient();

  // Contact search
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Contact[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [phone, setPhone] = useState('');

  // Message
  const [mode, setMode] = useState<MessageMode>('text');
  const [text, setText] = useState('');

  // Template
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<MessageTemplate | null>(null);
  const [params, setParams] = useState<string[]>([]);

  const [sending, setSending] = useState(false);

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load templates on open
  useEffect(() => {
    if (!open) return;
    setLoadingTemplates(true);
    supabase
      .from('message_templates')
      .select('*')
      .eq('status', 'Approved')
      .order('name')
      .then(({ data }) => {
        setTemplates(data ?? []);
        setLoadingTemplates(false);
      });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Contact search debounce
  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      const term = `%${query.trim()}%`;
      const { data } = await supabase
        .from('contacts')
        .select('*')
        .or(`name.ilike.${term},phone.ilike.${term}`)
        .limit(8);
      setResults(data ?? []);
      setSearching(false);
    }, 300);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset template params when template changes
  useEffect(() => {
    if (!selectedTemplate) { setParams([]); return; }
    const vars = extractParams(selectedTemplate.body_text);
    setParams(new Array(vars.length).fill(''));
  }, [selectedTemplate]);

  function reset() {
    setQuery('');
    setResults([]);
    setSelectedContact(null);
    setPhone('');
    setMode('text');
    setText('');
    setSelectedTemplate(null);
    setParams([]);
  }

  function handleOpenChange(val: boolean) {
    if (!val) reset();
    onOpenChange(val);
  }

  function selectContact(c: Contact) {
    setSelectedContact(c);
    setPhone(c.phone);
    setQuery('');
    setResults([]);
  }

  function clearContact() {
    setSelectedContact(null);
    setPhone('');
  }

  async function handleSend() {
    const targetPhone = selectedContact?.phone || phone.trim();
    if (!targetPhone) { toast.error('Enter a phone number'); return; }
    if (mode === 'text' && !text.trim()) { toast.error('Enter a message'); return; }
    if (mode === 'template' && !selectedTemplate) { toast.error('Select a template'); return; }

    setSending(true);
    try {
      // 1. Find or create contact + conversation
      const startRes = await fetch('/api/conversations/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: targetPhone,
          name: selectedContact?.name || undefined,
        }),
      });
      const startData = await startRes.json();
      if (!startRes.ok) throw new Error(startData.error || 'Failed to start conversation');

      const { conversation_id } = startData;

      // 2. Send the message
      const sendBody: Record<string, unknown> = { conversation_id };
      if (mode === 'text') {
        sendBody.message_type = 'text';
        sendBody.content_text = text.trim();
      } else {
        sendBody.message_type = 'template';
        sendBody.template_name = selectedTemplate!.name;
        sendBody.template_language = selectedTemplate!.language || 'en_US';
        sendBody.template_params = params;
      }

      const sendRes = await fetch('/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sendBody),
      });
      const sendData = await sendRes.json();
      if (!sendRes.ok) throw new Error(sendData.error || 'Failed to send message');

      toast.success('Message sent');
      handleOpenChange(false);
      router.push(`/inbox?c=${conversation_id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Send failed');
    } finally {
      setSending(false);
    }
  }

  const templateVars = selectedTemplate ? extractParams(selectedTemplate.body_text) : [];
  const canSend = !sending && (mode === 'text' ? !!text.trim() : !!selectedTemplate) && !!(selectedContact?.phone || phone.trim());

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="bg-slate-900 border-slate-700 text-slate-200 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-white">New Conversation</DialogTitle>
          <DialogDescription className="text-slate-400">
            Send a message to any contact or phone number.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Contact / phone picker */}
          <div className="space-y-1.5">
            <Label className="text-slate-300">To</Label>
            {selectedContact ? (
              <div className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-3 py-2">
                <span className="flex-1 text-sm text-white">
                  {selectedContact.name && <span className="font-medium">{selectedContact.name} · </span>}
                  <span className="font-mono text-slate-300">{selectedContact.phone}</span>
                </span>
                <button type="button" onClick={clearContact} className="text-slate-500 hover:text-white">
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                <Input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPhone(e.target.value);
                  }}
                  placeholder="Search contacts or enter phone number…"
                  className="pl-8 bg-slate-800 border-slate-700 text-white placeholder:text-slate-500"
                />
                {searching && (
                  <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-slate-500" />
                )}
                {results.length > 0 && (
                  <div className="absolute z-10 mt-1 w-full rounded-md border border-slate-700 bg-slate-800 shadow-lg">
                    {results.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => selectContact(c)}
                        className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-slate-700"
                      >
                        <span className="font-medium text-white">{c.name || 'Unnamed'}</span>
                        <span className="font-mono text-xs text-slate-400">{c.phone}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Mode toggle */}
          <div className="flex rounded-md border border-slate-700 p-0.5">
            <button
              type="button"
              onClick={() => setMode('text')}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded py-1.5 text-xs font-medium transition-colors ${mode === 'text' ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
            >
              <MessageSquare className="h-3.5 w-3.5" />
              Text
            </button>
            <button
              type="button"
              onClick={() => setMode('template')}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded py-1.5 text-xs font-medium transition-colors ${mode === 'template' ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
            >
              <LayoutTemplate className="h-3.5 w-3.5" />
              Template
            </button>
          </div>

          {mode === 'text' ? (
            <div className="space-y-1.5">
              <Label className="text-slate-300">Message</Label>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={4}
                placeholder="Type your message…"
                className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-violet-500 resize-none"
              />
              <p className="text-xs text-amber-400">
                Note: WhatsApp only allows free-form text within 24 h of last customer message. Use Template for first contact.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-slate-300">Template</Label>
                {loadingTemplates ? (
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
                  </div>
                ) : templates.length === 0 ? (
                  <p className="text-xs text-slate-500">No approved templates. Sync in Settings → Templates.</p>
                ) : (
                  <div className="max-h-44 space-y-1 overflow-y-auto">
                    {templates.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setSelectedTemplate(t)}
                        className={`w-full rounded-md border px-3 py-2 text-left text-xs transition-colors ${selectedTemplate?.id === t.id ? 'border-violet-500 bg-violet-500/10 text-violet-300' : 'border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-600'}`}
                      >
                        <span className="font-medium">{t.name}</span>
                        <span className="ml-1 text-slate-500">· {t.language || 'en_US'}</span>
                        <p className="mt-0.5 line-clamp-1 text-slate-400">{t.body_text}</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Param inputs */}
              {selectedTemplate && templateVars.length > 0 && (
                <div className="space-y-2">
                  <Label className="text-slate-300">Variables</Label>
                  {templateVars.map((n, i) => (
                    <div key={n} className="flex items-center gap-2">
                      <span className="w-8 shrink-0 text-xs font-mono text-violet-400">{`{{${n}}}`}</span>
                      <Input
                        value={params[i] ?? ''}
                        onChange={(e) => setParams((prev) => { const next = [...prev]; next[i] = e.target.value; return next; })}
                        placeholder={`Variable ${n}`}
                        className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500"
                      />
                    </div>
                  ))}
                  <div className="rounded-md bg-slate-800/50 p-2 text-xs text-slate-400">
                    Preview: {renderPreview(selectedTemplate.body_text, params)}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="border-slate-700">
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            className="border-slate-700 text-slate-300 hover:bg-slate-800"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSend}
            disabled={!canSend}
            className="bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50"
          >
            {sending && <Loader2 className="h-4 w-4 animate-spin" />}
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
