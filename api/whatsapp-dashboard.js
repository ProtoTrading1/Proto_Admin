import { requireAdminKey } from './_admin-auth.js';
import { watiCrmConfig } from './_wati-client.js';
import { getWhatsappDbClient, resolveWhatsappAudience } from './_whatsapp-audience.js';
import { formatWhatsappPhone } from './_whatsapp-phone.js';

/**
 * Headline numbers for the WhatsApp CRM dashboard.
 *
 * Audience figures come from the send-path resolver, not a separate query, so
 * "1 412 reachable" on the dashboard is the same 1 412 a broadcast would reach.
 *
 * GET ?days=30
 */
export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  res.setHeader('Cache-Control', 'no-store');

  const days = Math.min(365, Math.max(1, Number.parseInt(String(req.query.days || '30'), 10) || 30));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  try {
    const sb = getWhatsappDbClient();
    const { recipients, skipped } = await resolveWhatsappAudience(sb, { audience: 'all' });

    const optedOut = skipped.filter((r) => r.reason === 'Opted out of WhatsApp');
    const unusable = skipped.filter((r) => r.reason !== 'Opted out of WhatsApp');

    const outbound = () => sb
      .from('whatsapp_messages')
      .select('phone', { count: 'exact', head: true })
      .eq('direction', 'out')
      .gte('created_at', since);

    const [
      syncedResult,
      broadcastsResult,
      sentResult,
      deliveredResult,
      readResult,
      repliedResult,
      failedResult,
      clickedResult,
      recentBroadcasts,
      recentOptOuts,
      lastSyncResult,
    ] = await Promise.all([
      sb.from('whatsapp_contacts').select('phone', { count: 'exact', head: true }).eq('sync_status', 'synced'),
      sb.from('whatsapp_broadcasts').select('id', { count: 'exact', head: true }).gte('created_at', since),
      outbound().in('status', ['sent', 'delivered', 'read']),
      outbound().not('delivered_at', 'is', null),
      outbound().not('read_at', 'is', null),
      outbound().not('replied_at', 'is', null),
      outbound().eq('status', 'failed'),
      outbound().gt('click_count', 0),
      sb.from('whatsapp_broadcasts')
        .select('id, broadcast_name, template_name, status, total_targeted, count_sent, count_failed, count_clicked, created_at, completed_at')
        .order('created_at', { ascending: false })
        .limit(5),
      sb.from('whatsapp_opt_outs')
        .select('phone, source, reason, opted_out_at')
        .order('opted_out_at', { ascending: false })
        .limit(5),
      sb.from('whatsapp_contacts')
        .select('wati_synced_at')
        .not('wati_synced_at', 'is', null)
        .order('wati_synced_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const sent = sentResult.count || 0;
    const delivered = deliveredResult.count || 0;
    const read = readResult.count || 0;
    const clicked = clickedResult.count || 0;
    const rate = (part) => (sent > 0 ? Math.round((part / sent) * 1000) / 10 : 0);

    return res.status(200).json({
      configured: watiCrmConfig().configured,
      windowDays: days,
      audience: {
        optedIn: recipients.length + skipped.length,
        reachable: recipients.length,
        optedOut: optedOut.length,
        unusableNumber: unusable.length,
        syncedToWati: syncedResult.count || 0,
        awaitingSync: Math.max(0, recipients.length - (syncedResult.count || 0)),
      },
      activity: {
        broadcasts: broadcastsResult.count || 0,
        sent,
        delivered,
        read,
        replied: repliedResult.count || 0,
        failed: failedResult.count || 0,
        clicked,
        deliveredRate: rate(delivered),
        readRate: rate(read),
        clickRate: rate(clicked),
      },
      lastSyncedAt: lastSyncResult?.data?.wati_synced_at || null,
      recentBroadcasts: (recentBroadcasts.data || []).map((row) => ({
        id: row.id,
        name: row.broadcast_name,
        templateName: row.template_name,
        status: row.status,
        targeted: row.total_targeted || 0,
        sent: row.count_sent || 0,
        failed: row.count_failed || 0,
        clicked: row.count_clicked || 0,
        createdAt: row.created_at,
        completedAt: row.completed_at,
      })),
      recentOptOuts: (recentOptOuts.data || []).map((row) => ({
        phone: row.phone,
        phoneDisplay: formatWhatsappPhone(row.phone),
        source: row.source,
        reason: row.reason,
        optedOutAt: row.opted_out_at,
      })),
    });
  } catch (err) {
    console.error('whatsapp-dashboard:', err?.message || err);
    return res.status(500).json({ error: err.message || 'Failed to load the WhatsApp dashboard' });
  }
}
