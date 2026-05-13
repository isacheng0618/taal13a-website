import { createClient } from '@supabase/supabase-js';

import { createMollieClient } from '@mollie/api-client';

const supabase = createClient(

  process.env.SUPABASE_URL,

  process.env.SUPABASE_SERVICE_ROLE_KEY

);

const mollie = createMollieClient({

  apiKey: process.env.MOLLIE_API_KEY

});

function isEmail(value) {

  return typeof value === 'string' && value.includes('@') && value.includes('.');

}

export default async function handler(req, res) {

  if (req.method !== 'POST') {

    return res.status(405).json({ error: 'Method not allowed' });

  }

  try {

    const {

      username,

      email,

      wechat,

      note,

      items,

      acceptedTerms,

      acceptedDigitalDelivery

    } = req.body || {};

    if (!username || !isEmail(email)) {

      return res.status(400).json({ error: 'Please enter a valid username and email.' });

    }

    if (!Array.isArray(items) || items.length === 0) {

      return res.status(400).json({ error: 'Your cart is empty.' });

    }

    if (!acceptedTerms || !acceptedDigitalDelivery) {

      return res.status(400).json({

        error: 'Please accept the terms and the digital delivery consent.'

      });

    }

    const cleanItems = items

      .map(item => ({

        productId: String(item.productId || item.id || ''),

        quantity: Math.max(1, Number(item.quantity || item.qty || 1))

      }))

      .filter(item => item.productId);

    const productIds = [...new Set(cleanItems.map(item => item.productId))];

    const { data: products, error: productError } = await supabase

      .from('products')

      .select('*')

      .in('id', productIds)

      .eq('active', true);

    if (productError) throw productError;

    if (!products || products.length !== productIds.length) {

      return res.status(400).json({ error: 'One or more products are unavailable.' });

    }

    let totalCents = 0;

    const orderItems = [];

    for (const item of cleanItems) {

      const product = products.find(p => p.id === item.productId);

      if (!product) continue;

      totalCents += product.price_cents * item.quantity;

      orderItems.push({

        product_id: product.id,

        quantity: item.quantity,

        unit_price_cents: product.price_cents

      });

    }

    if (totalCents <= 0) {

      return res.status(400).json({ error: 'Invalid order amount.' });

    }

    const { data: order, error: orderError } = await supabase

      .from('orders')

      .insert({

        username,

        email,

        wechat: wechat || null,

        note: note || null,

        total_cents: totalCents,

        currency: 'EUR',

        status: 'pending'

      })

      .select()

      .single();

    if (orderError) throw orderError;

    const { error: itemError } = await supabase

      .from('order_items')

      .insert(orderItems.map(item => ({

        ...item,

        order_id: order.id

      })));

    if (itemError) throw itemError;

    const amountValue = (totalCents / 100).toFixed(2);

    const payment = await mollie.payments.create({

      amount: {

        currency: 'EUR',

        value: amountValue

      },

      description: `Taal13A order ${order.id}`,

      redirectUrl: `${process.env.SITE_URL}/?payment=return&order=${order.id}`,

      webhookUrl: `${process.env.SITE_URL}/api/mollie-webhook`,

      metadata: {

        orderId: order.id,

        email

      }

    });

    await supabase

      .from('orders')

      .update({ mollie_payment_id: payment.id })

      .eq('id', order.id);

    return res.status(200).json({

      checkoutUrl: payment._links.checkout.href,

      orderId: order.id

    });

  } catch (error) {

    console.error('create-payment error:', error);

    return res.status(500).json({ error: 'Could not create payment.' });

  }

}
