import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { normalizePhone, sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { phone: rawPhone, name } = await request.json()
    if (!rawPhone) {
      return NextResponse.json({ error: 'phone is required' }, { status: 400 })
    }

    const phone = normalizePhone(rawPhone)
    const sanitized = sanitizePhoneForMeta(phone)
    if (!isValidE164(sanitized)) {
      return NextResponse.json({ error: 'Invalid phone number — use E.164 format (e.g. 8801XXXXXXXXX)' }, { status: 400 })
    }

    // Find or create contact
    const { data: contacts } = await supabase
      .from('contacts')
      .select('*')
      .eq('user_id', user.id)

    const existing = (contacts ?? []).find((c: { phone: string }) => {
      const a = c.phone.replace(/\D/g, '')
      const b = phone.replace(/\D/g, '')
      return a === b || a.endsWith(b) || b.endsWith(a)
    })

    let contactId: string
    let isNewContact = false

    if (existing) {
      contactId = existing.id
      if (name && name !== existing.name) {
        await supabase.from('contacts').update({ name }).eq('id', existing.id)
      }
    } else {
      const { data: newContact, error: createErr } = await supabase
        .from('contacts')
        .insert({ user_id: user.id, phone, name: name || phone })
        .select()
        .single()
      if (createErr || !newContact) {
        return NextResponse.json({ error: 'Failed to create contact' }, { status: 500 })
      }
      contactId = newContact.id
      isNewContact = true
    }

    // Find or create conversation
    const { data: convRows } = await supabase
      .from('conversations')
      .select('*')
      .eq('user_id', user.id)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: true })
      .limit(1)

    let conversationId: string
    let isNewConversation = false

    if (convRows && convRows.length > 0) {
      conversationId = convRows[0].id
    } else {
      const { data: newConv, error: convErr } = await supabase
        .from('conversations')
        .insert({ user_id: user.id, contact_id: contactId })
        .select()
        .single()
      if (convErr || !newConv) {
        return NextResponse.json({ error: 'Failed to create conversation' }, { status: 500 })
      }
      conversationId = newConv.id
      isNewConversation = true
    }

    return NextResponse.json({ conversation_id: conversationId, contact_id: contactId, is_new_contact: isNewContact, is_new_conversation: isNewConversation })
  } catch (err) {
    console.error('[conversations/start]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
