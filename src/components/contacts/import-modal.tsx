'use client';

import { useState, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Upload, FileText, Loader2, CheckCircle, XCircle } from 'lucide-react';

interface ImportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}

interface ParsedRow {
  phone: string;
  name?: string;
  email?: string;
  company?: string;
}

// Column aliases recognised as phone / name / email / company.
// Lower-cased and stripped of spaces for matching.
const PHONE_ALIASES = ['phone', 'recipient phone', 'recipientphone', 'phone number', 'phonenumber', 'mobile', 'whatsapp', 'contact']
const NAME_ALIASES  = ['name', 'recipient name', 'recipientname', 'full name', 'fullname', 'customer name', 'customername']
const EMAIL_ALIASES = ['email', 'e-mail', 'email address']
const COMPANY_ALIASES = ['company', 'organization', 'organisation', 'business']

function findColIdx(headers: string[], aliases: string[]): number {
  for (const alias of aliases) {
    const idx = headers.indexOf(alias)
    if (idx !== -1) return idx
  }
  return -1
}

// Normalise a phone number to E.164.
// BD numbers: strip leading 0, prepend 880 → 01849222290 → 8801849222290
// Already has +/country code: strip +
function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (!digits) return raw
  // Already has full country code (11+ digits starting with non-zero country code)
  if (digits.length >= 11 && digits[0] !== '0') return digits
  // Leading 0 — assume BD (880) — strip 0, prepend 880
  if (digits.startsWith('0') && digits.length === 11) return '880' + digits.slice(1)
  // 10-digit BD without leading 0
  if (digits.length === 10 && !digits.startsWith('0')) return '880' + digits
  return digits
}

function detectDelimiter(firstLine: string): string {
  const tabs = (firstLine.match(/\t/g) || []).length
  const commas = (firstLine.match(/,/g) || []).length
  const semis = (firstLine.match(/;/g) || []).length
  if (tabs > commas && tabs > semis) return '\t'
  if (semis > commas) return ';'
  return ','
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const values: string[] = []
  let current = ''
  let inQuotes = false
  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes
    } else if (char === delimiter && !inQuotes) {
      values.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  values.push(current.trim())
  return values
}

// Heuristic: does a string look like a phone number?
// Matches BD local (01XXXXXXXXX), E.164 (8801XXXXXXXXX), and generic 7-15 digit numbers.
function looksLikePhone(val: string): boolean {
  const digits = val.replace(/\D/g, '')
  return digits.length >= 7 && digits.length <= 15 && !/^20\d{2}/.test(digits) // exclude years like 2026...
}

// Scan data rows to find which column index most consistently holds phone numbers.
function detectPhoneColumnByData(dataLines: string[], delimiter: string): number {
  const scores: Record<number, number> = {}
  const sample = dataLines.slice(0, Math.min(20, dataLines.length))
  for (const line of sample) {
    const values = parseCsvLine(line, delimiter)
    for (let i = 0; i < values.length; i++) {
      const v = values[i].replace(/["']/g, '').trim()
      if (looksLikePhone(v)) {
        scores[i] = (scores[i] ?? 0) + 1
      }
    }
  }
  let best = -1, bestScore = 0
  for (const [idx, score] of Object.entries(scores)) {
    if (score > bestScore) { bestScore = score; best = Number(idx) }
  }
  // Require at least 30% of sampled rows to have phone-like value in that column
  return bestScore >= Math.max(1, sample.length * 0.3) ? best : -1
}

// Similarly find name column: largest index before the phone column
// whose values are mostly alphabetic (not dates/numbers).
function detectNameColumnByData(dataLines: string[], delimiter: string, phoneIdx: number): number {
  if (phoneIdx <= 0) return -1
  const sample = dataLines.slice(0, Math.min(20, dataLines.length))
  let best = -1, bestScore = 0
  for (let i = 0; i < phoneIdx; i++) {
    let score = 0
    for (const line of sample) {
      const val = parseCsvLine(line, delimiter)[i]?.replace(/["']/g, '').trim() ?? ''
      if (val && /[a-zA-Zঀ-৿]{2,}/.test(val) && !/^\d{4}-\d{2}/.test(val)) score++
    }
    if (score > bestScore) { bestScore = score; best = i }
  }
  return bestScore >= Math.max(1, sample.length * 0.3) ? best : -1
}

function parseCSV(text: string): ParsedRow[] {
  // Strip UTF-8 BOM if present (Excel adds this)
  const clean = text.replace(/^﻿/, '').trim()
  const lines = clean.split(/\r?\n/)
  if (lines.length < 1) return []

  const delimiter = detectDelimiter(lines[0])

  // Try header-based detection first
  const firstLineCells = parseCsvLine(lines[0], delimiter).map((h) => h.toLowerCase().replace(/["']/g, '').trim())
  let phoneIdx   = findColIdx(firstLineCells, PHONE_ALIASES)
  let nameIdx    = findColIdx(firstLineCells, NAME_ALIASES)
  let emailIdx   = findColIdx(firstLineCells, EMAIL_ALIASES)
  let companyIdx = findColIdx(firstLineCells, COMPANY_ALIASES)
  let dataStartLine = 1

  // Fallback: no header row — detect columns by data patterns
  if (phoneIdx === -1) {
    phoneIdx = detectPhoneColumnByData(lines, delimiter)
    if (phoneIdx === -1) return []
    nameIdx    = detectNameColumnByData(lines, delimiter, phoneIdx)
    emailIdx   = -1
    companyIdx = -1
    dataStartLine = 0 // first line is data, not headers
  }

  const rows: ParsedRow[] = []
  for (let i = dataStartLine; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    const values = parseCsvLine(line, delimiter)

    const rawPhone = values[phoneIdx]?.replace(/["']/g, '').trim()
    if (!rawPhone) continue
    const phone = normalizePhone(rawPhone)
    if (!phone || phone.length < 7) continue

    rows.push({
      phone,
      name:    nameIdx    >= 0 ? values[nameIdx]?.replace(/["']/g, '').trim()    || undefined : undefined,
      email:   emailIdx   >= 0 ? values[emailIdx]?.replace(/["']/g, '').trim()   || undefined : undefined,
      company: companyIdx >= 0 ? values[companyIdx]?.replace(/["']/g, '').trim() || undefined : undefined,
    })
  }

  return rows
}

export function ImportModal({ open, onOpenChange, onImported }: ImportModalProps) {
  const supabase = createClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ imported: number; failed: number } | null>(null);

  function reset() {
    setFile(null);
    setParsedRows([]);
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleOpenChange(open: boolean) {
    if (!open) reset();
    onOpenChange(open);
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;

    setFile(selected);
    setResult(null);

    const text = await selected.text();
    const rows = parseCSV(text);

    if (rows.length === 0) {
      // Show first few detected headers to help user debug column name mismatch
      const clean = text.replace(/^﻿/, '').trim()
      const firstLine = clean.split(/\r?\n/)[0] || ''
      const delim = detectDelimiter(firstLine)
      const found = firstLine.split(delim).slice(0, 6).map(h => h.replace(/["']/g, '').trim()).join(', ')
      toast.error(`Phone column not found. Detected headers: ${found || '(none)'}`)
      setParsedRows([]);
      return;
    }

    setParsedRows(rows);
  }

  async function handleImport() {
    if (parsedRows.length === 0) return;
    setImporting(true);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) throw new Error('Not authenticated');

      let imported = 0;
      let failed = 0;

      // Upsert in chunks — skip rows whose phone already exists for this user.
      const chunkSize = 200;
      for (let i = 0; i < parsedRows.length; i += chunkSize) {
        const chunk = parsedRows.slice(i, i + chunkSize);
        const rows = chunk.map((row) => ({
          user_id: user.id,
          phone: row.phone,
          name: row.name || null,
          email: row.email || null,
          company: row.company || null,
        }));

        const { data, error } = await supabase
          .from('contacts')
          .upsert(rows, { onConflict: 'user_id,phone', ignoreDuplicates: true })
          .select('id');

        if (error) {
          failed += chunk.length;
        } else {
          imported += data?.length ?? chunk.length;
        }
      }

      setResult({ imported, failed });
      if (imported > 0) {
        toast.success(`${imported} contact${imported !== 1 ? 's' : ''} imported`);
        onImported();
      }
      if (failed > 0) {
        toast.error(`${failed} contact${failed !== 1 ? 's' : ''} failed to import`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Import failed';
      toast.error(message);
    } finally {
      setImporting(false);
    }
  }

  const preview = parsedRows.slice(0, 5);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="bg-slate-900 border-slate-700 text-slate-200 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-white">Import Contacts</DialogTitle>
          <DialogDescription className="text-slate-400">
            Upload a CSV file. Phone column required (accepts: phone, &quot;Recipient Phone&quot;, mobile…).
            Optional: name / &quot;Recipient Name&quot;, email, company.
            BD numbers (01XXXXXXXXX) auto-convert to E.164. Duplicates skipped.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Upload area */}
          <div
            onClick={() => fileInputRef.current?.click()}
            className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-slate-700 p-6 cursor-pointer hover:border-violet-500/50 transition-colors"
          >
            {file ? (
              <>
                <FileText className="size-8 text-violet-400" />
                <p className="text-sm text-slate-300">{file.name}</p>
                <p className="text-xs text-slate-500">
                  {parsedRows.length} row{parsedRows.length !== 1 ? 's' : ''} detected
                </p>
              </>
            ) : (
              <>
                <Upload className="size-8 text-slate-500" />
                <p className="text-sm text-slate-400">
                  Click to upload CSV file
                </p>
                <p className="text-xs text-slate-500">
                  CSV with &quot;phone&quot; column required
                </p>
              </>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileChange}
            className="hidden"
          />

          {/* Preview table */}
          {preview.length > 0 && !result && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                Preview (first {preview.length} rows)
              </p>
              <div className="rounded-lg border border-slate-700 overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-slate-800">
                      <th className="px-3 py-1.5 text-left text-slate-400 font-medium">Phone</th>
                      <th className="px-3 py-1.5 text-left text-slate-400 font-medium">Name</th>
                      <th className="px-3 py-1.5 text-left text-slate-400 font-medium">Email</th>
                      <th className="px-3 py-1.5 text-left text-slate-400 font-medium">Company</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((row, i) => (
                      <tr key={i} className="border-t border-slate-700/50">
                        <td className="px-3 py-1.5 text-slate-300">{row.phone}</td>
                        <td className="px-3 py-1.5 text-slate-300">{row.name || '-'}</td>
                        <td className="px-3 py-1.5 text-slate-300">{row.email || '-'}</td>
                        <td className="px-3 py-1.5 text-slate-300">{row.company || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {parsedRows.length > 5 && (
                <p className="text-xs text-slate-500">
                  ...and {parsedRows.length - 5} more rows
                </p>
              )}
            </div>
          )}

          {/* Results */}
          {result && (
            <div className="rounded-lg border border-slate-700 p-4 space-y-2">
              <p className="text-sm font-medium text-white">Import Complete</p>
              <div className="flex items-center gap-4">
                {result.imported > 0 && (
                  <div className="flex items-center gap-1.5 text-violet-400 text-sm">
                    <CheckCircle className="size-4" />
                    {result.imported} imported
                  </div>
                )}
                {result.failed > 0 && (
                  <div className="flex items-center gap-1.5 text-red-400 text-sm">
                    <XCircle className="size-4" />
                    {result.failed} failed
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="bg-slate-900 border-slate-700">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            className="border-slate-700 text-slate-300 hover:bg-slate-800"
          >
            {result ? 'Close' : 'Cancel'}
          </Button>
          {!result && (
            <Button
              type="button"
              disabled={parsedRows.length === 0 || importing}
              onClick={handleImport}
              className="bg-violet-600 hover:bg-violet-700 text-white"
            >
              {importing && <Loader2 className="size-4 animate-spin" />}
              Import {parsedRows.length > 0 ? `${parsedRows.length} Contacts` : ''}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
