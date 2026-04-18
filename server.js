require('dotenv').config();
const wppconnect = require('@wppconnect-team/wppconnect');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SESSION_NAME = process.env.SESSION_NAME || 'solfy-whatsapp';
const POLL_INTERVAL_MS = 5000; // verifica novos pedidos a cada 5 segundos

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL e SUPABASE_SERVICE_KEY são obrigatórios no .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Estado global ────────────────────────────────────────────────────────────
let whatsappClient = null;
let connectionStatus = 'disconnected';
let currentQrCode = null;
let lastCheckedAt = new Date().toISOString(); // só pega pedidos APÓS o servidor iniciar

// ─── Express ─────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.json({ service: 'SOLFY WhatsApp Backend', status: connectionStatus }));

app.get('/api/status', (req, res) => {
  res.json({
    status: connectionStatus,
    qrCode: connectionStatus === 'qr_pending' ? currentQrCode : null,
    lastCheckedAt,
    message: {
      disconnected: 'Desconectado.',
      qr_pending: 'Aguardando QR Code.',
      connected: 'WhatsApp conectado e enviando mensagens!',
    }[connectionStatus],
  });
});

// Disparo manual (teste)
app.post('/api/send-order', async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'orderId é obrigatório' });
  const result = await processOrder(orderId);
  res.json(result);
});

// ─── WPPConnect ───────────────────────────────────────────────────────────────
async function initWhatsApp() {
  console.log('🔄 Iniciando WPPConnect...');
  connectionStatus = 'qr_pending';

  try {
    whatsappClient = await wppconnect.create({
      session: SESSION_NAME,
      catchQR: (base64Qr) => {
        console.log('📱 QR Code gerado! Acesse http://localhost:' + PORT + '/api/status');
        currentQrCode = base64Qr;
        connectionStatus = 'qr_pending';
      },
      statusFind: (statusSession) => {
        console.log('📡 WPP Status:', statusSession);
        if ((statusSession === 'inChat' || statusSession === 'isLogged') && connectionStatus !== 'connected') {
          connectionStatus = 'connected';
          currentQrCode = null;
          console.log('✅ WhatsApp conectado! Iniciando polling de pedidos...');
          startPolling();
        }
      },
      headless: true,
      puppeteerOptions: {
        args: [
          '--no-sandbox', '--disable-setuid-sandbox',
          '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas',
          '--no-first-run', '--no-zygote', '--single-process', '--disable-gpu'
        ],
      },
      logQR: false,
    });

    connectionStatus = 'connected';
    console.log('✅ WPPConnect pronto!');
    startPolling();
  } catch (err) {
    console.error('❌ Erro ao iniciar WPPConnect:', err.message);
    connectionStatus = 'disconnected';
  }
}

// ─── Polling: verifica novos pedidos a cada N segundos ────────────────────────
let pollingActive = false;

function startPolling() {
  if (pollingActive) return;
  pollingActive = true;
  console.log(`\n🔍 Polling ativo — verificando novos pedidos a cada ${POLL_INTERVAL_MS / 1000}s...\n`);

  setInterval(async () => {
    try {
      const now = new Date().toISOString();

      // Buscar pedidos com status 'new' criados após o último check
      const { data: newOrders, error } = await supabase
        .from('help_requests')
        .select('*')
        .eq('status', 'new')
        .gte('created_at', lastCheckedAt)
        .order('created_at', { ascending: true });

      lastCheckedAt = now;

      if (error) {
        console.error('❌ Erro ao buscar pedidos:', error.message);
        return;
      }

      if (newOrders && newOrders.length > 0) {
        console.log(`\n📨 ${newOrders.length} novo(s) pedido(s) encontrado(s)!`);
        for (const order of newOrders) {
          await processOrder(order.id, order);
        }
      }
    } catch (err) {
      console.error('❌ Erro no polling:', err.message);
    }
  }, POLL_INTERVAL_MS);
}

// ─── Processar e enviar pedido ────────────────────────────────────────────────
async function processOrder(orderId, orderData = null) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📦 Processando pedido: ${orderId}`);

  try {
    // 1. Verificar configuração
    const { data: settings, error: settingsError } = await supabase
      .from('app_settings')
      .select('key, value')
      .in('key', ['auto_send_whatsapp', 'max_helpers_per_order', 'send_delay_seconds']);

    if (settingsError) {
      console.error('❌ Erro ao buscar configurações:', settingsError.message);
      console.log('⚠️ Rode a migration 005 no Supabase!');
      // Continua com defaults se a tabela não existir
    }

    const settingsMap = {};
    (settings || []).forEach((s) => { settingsMap[s.key] = s.value; });

    const autoSend = settingsMap['auto_send_whatsapp'] === 'true';
    const maxHelpers = parseInt(settingsMap['max_helpers_per_order'] || '5');
    const delaySeconds = parseInt(settingsMap['send_delay_seconds'] || '3');

    console.log(`⚙️ auto_send=${autoSend} | max=${maxHelpers} | delay=${delaySeconds}s`);

    if (!autoSend) {
      console.log('⏸ Auto-envio DESATIVADO. Ative em Configurações → Automação.');
      return { success: false, reason: 'auto_send_disabled', sent: 0 };
    }

    if (connectionStatus !== 'connected' || !whatsappClient) {
      console.log('⚠️ WhatsApp não conectado.');
      return { success: false, reason: 'whatsapp_disconnected', sent: 0 };
    }

    // 2. Buscar dados do pedido
    if (!orderData) {
      const { data, error } = await supabase.from('help_requests').select('*').eq('id', orderId).single();
      if (error || !data) {
        console.error('❌ Pedido não encontrado:', orderId);
        return { success: false, reason: 'order_not_found', sent: 0 };
      }
      orderData = data;
    }

    console.log(`🎯 Pedido: "${orderData.description}" | Cidade: "${orderData.city}" | Local: "${orderData.location}"`);

    // 3. Buscar prestadores ativos
    const { data: helpers, error: helpersError } = await supabase
      .from('helpers').select('*').eq('is_active', true);

    if (helpersError) {
      console.error('❌ Erro ao buscar helpers:', helpersError.message);
      // Tenta sem o filtro is_active (caso a coluna não exista ainda)
      const { data: allHelpers } = await supabase.from('helpers').select('*');
      console.log(`⚠️ Usando todos os helpers (${(allHelpers || []).length}). Rode a migration 005!`);
      return sendToHelpers(orderId, orderData, allHelpers || [], maxHelpers, delaySeconds);
    }

    console.log(`👥 Prestadores ativos: ${(helpers || []).length}`);

    if ((helpers || []).length === 0) {
      console.log('⚠️ Nenhum prestador ativo. Cadastre prestadores no painel admin.');
      return { success: true, reason: 'no_active_helpers', sent: 0 };
    }

    // 4. Filtrar por cidade (com fallback para todos)
    const orderCity = (orderData.city || '').toLowerCase().trim();
    const orderLocation = (orderData.location || '').toLowerCase().trim();
    
    // Tentamos usar a cidade nova primeiro, senão cai pro fallback da localização
    const searchTerms = orderCity ? orderCity.split(/[\s,\-\/]+/).filter(w => w.length > 1) 
                                  : orderLocation.split(/[\s,\-\/]+/).filter(w => w.length > 1);

    const matchedHelpers = (helpers || []).filter((helper) => {
      const helperCity = ((helper.city || '') + ' ' + (helper.service_type || '')).toLowerCase();
      if (!helperCity.trim()) return true;
      const cityParts = helperCity.split(/[\s,\-\/]+/).filter(w => w.length > 1);
      return searchTerms.some(w => helperCity.includes(w)) || cityParts.some(w => orderLocation.includes(w) || orderCity.includes(w));
    });

    const targetHelpers = matchedHelpers.length > 0 ? matchedHelpers : (helpers || []);
    console.log(`🗺️ Match por cidade: ${matchedHelpers.length} | Fallback: ${matchedHelpers.length === 0 ? 'SIM (enviando para todos)' : 'NÃO'}`);
    targetHelpers.forEach(h => console.log(`   → ${h.name} | ${h.phone}`));

    return sendToHelpers(orderId, orderData, targetHelpers, maxHelpers, delaySeconds);
  } catch (err) {
    console.error('❌ Erro inesperado:', err.message);
    return { success: false, reason: err.message, sent: 0 };
  }
}

// ─── Envio de mensagens ───────────────────────────────────────────────────────
async function sendToHelpers(orderId, orderData, helpers, maxHelpers, delaySeconds) {
  const selected = helpers.slice(0, maxHelpers);
  console.log(`📤 Enviando para ${selected.length} prestador(es)...`);

  const urgencyMap = { now: '🔴 URGENTE - Agora', today: '🟡 Hoje', this_week: '🟢 Essa semana' };
  const urgency = urgencyMap[orderData.urgency] || orderData.urgency || 'Não informado';
  const valor = orderData.price
    ? `R$ ${Number(orderData.price).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
    : 'A combinar';

  const message =
    `🚨 *NOVO PEDIDO - SOLFY*\n\n` +
    `🏙️ *Cidade:* ${orderData.city || 'Não informada'}\n` +
    `📍 *Bairro/Local:* ${orderData.location}\n` +
    `🛠 *Serviço:* ${orderData.description}\n` +
    `💰 *Valor:* ${valor}\n` +
    `⏰ *Urgência:* ${urgency}\n` +
    `📞 *Contato:* ${orderData.phone}\n\n` +
    `_Responda para se candidatar. Plataforma SOLFY_`;

  const results = [];
  for (let i = 0; i < selected.length; i++) {
    const helper = selected[i];
    try {
      const digits = helper.phone.replace(/\D/g, '');
      const phone = digits.startsWith('55') ? digits : `55${digits}`;
      const target = `${phone}@c.us`;

      console.log(`  📲 [${i + 1}/${selected.length}] ${helper.name} → ${target}`);
      await whatsappClient.sendText(target, message);
      console.log(`  ✅ Enviado!`);
      results.push({ helper: helper.name, phone: helper.phone, status: 'sent' });

      // Registrar no banco
      try {
        await supabase.from('request_helpers').upsert(
          { request_id: orderId, helper_id: helper.id, status: 'notified' },
          { onConflict: 'request_id,helper_id', ignoreDuplicates: true }
        );
      } catch (_) {}

      if (i < selected.length - 1) {
        console.log(`  ⏳ ${delaySeconds}s...`);
        await sleep(delaySeconds * 1000);
      }
    } catch (sendErr) {
      console.error(`  ❌ Falha para ${helper.name}:`, sendErr.message);
      results.push({ helper: helper.name, phone: helper.phone, status: 'error', error: sendErr.message });
    }
  }

  // Atualizar status
  await supabase.from('help_requests').update({ status: 'sent_to_helpers' }).eq('id', orderId);

  const sentCount = results.filter(r => r.status === 'sent').length;
  console.log(`\n✅ Concluído: ${sentCount}/${selected.length} enviados.`);
  console.log(`${'─'.repeat(50)}\n`);

  return { success: true, sent: sentCount, total: selected.length, results };
}

// ─── Utilitário ───────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 SOLFY WhatsApp Backend - Porta ${PORT}`);
  console.log(`📊 Status: http://localhost:${PORT}/api/status\n`);
  initWhatsApp();
});
