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

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeShipping(shipping) {
  if (!shipping || typeof shipping !== 'object') {
    return null;
  }

  return {
    name: cleanString(shipping.name),
    address: cleanString(shipping.address),
    postcode: cleanString(shipping.postcode),
    city: cleanString(shipping.city),
    country: cleanString(shipping.country),
    contact: cleanString(shipping.contact)
  };
}

function isShippingComplete(shipping) {
  return Boolean(
    shipping &&
    shipping.name &&
    shipping.address &&
    shipping.postcode &&
    shipping.city &&
    shipping.country
  );
}

function isPhysicalProductFromDb(product) {
  if (!product) return false;

  return (
    product.format === 'physical' ||
    product.type === 'merch' ||
    product.shipping === true ||
    product.shipping_required === true ||
    product.requires_shipping === true ||
    product.product_type === 'physical'
  );
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
      shipping,
      hasPhysicalProduct,
      acceptedTerms,
      acceptedDigitalDelivery
    } = req.body;

    if (!username || !isEmail(email)) {
      return res.status(400).json({
        error: 'Please enter a valid username and email.'
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        error: 'Your cart is empty.'
      });
    }

    if (!acceptedTerms) {
      return res.status(400).json({
        error: 'Please accept the terms.'
      });
    }

    if (!acceptedDigitalDelivery) {
      return res.status(400).json({
        error: 'Please accept the digital delivery consent.'
      });
    }

    const cleanItems = items
      .map((item) => ({
        productId: String(item.productId || item.id || ''),
        quantity: Math.max(1, Number(item.quantity || item.qty || 1)),
        kind: String(item.kind || 'product')
      }))
      .filter((item) => item.productId);

    if (!cleanItems.length) {
      return res.status(400).json({
        error: 'Your cart is empty.'
      });
    }

    const productIds = [...new Set(cleanItems.map((item) => item.productId))];

    const { data: products, error: productError } = await supabase
      .from('products')
      .select('*')
      .in('id', productIds)
      .eq('active', true);

    if (productError) throw productError;

    if (!products || products.length !== productIds.length) {
      return res.status(400).json({
        error: 'One or more products are unavailable.'
      });
    }

    let totalCents = 0;
    const orderItems = [];

    for (const item of cleanItems) {
      const product = products.find((p) => p.id === item.productId);

      if (!product) continue;

      const quantity = item.quantity;
      const unitPriceCents = Number(product.price_cents || 0);

      totalCents += unitPriceCents * quantity;

      orderItems.push({
        product_id: product.id,
        quantity,
        unit_price_cents: unitPriceCents
      });
    }

    if (totalCents <= 0) {
      return res.status(400).json({
        error: 'Invalid order amount.'
      });
    }

    const hasPhysicalFromProducts = products.some((product) =>
      isPhysicalProductFromDb(product)
    );

    const finalHasPhysicalProduct =
      hasPhysicalFromProducts || hasPhysicalProduct === true;

    const normalizedShipping = normalizeShipping(shipping);

    if (finalHasPhysicalProduct && !isShippingComplete(normalizedShipping)) {
      return res.status(400).json({
        error: 'Missing shipping information for physical product.'
      });
    }

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert({
        username,
        email,
        wechat: wechat || null,
        note: note || null,

        accepted_terms: acceptedTerms === true,
        accepted_digital_delivery: acceptedDigitalDelivery === true,

        total_cents: totalCents,
        currency: 'EUR',
        status: 'pending',

        has_physical_product: finalHasPhysicalProduct,
        shipping_info: finalHasPhysicalProduct ? normalizedShipping : null,
        fulfillment_status: finalHasPhysicalProduct ? 'pending' : 'none'
      })
      .select()
      .single();

    if (orderError) throw orderError;

    const { error: itemError } = await supabase
      .from('order_items')
      .insert(
        orderItems.map((item) => ({
          ...item,
          order_id: order.id
        }))
      );

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
        email,
        hasPhysicalProduct: finalHasPhysicalProduct,
        shipping: finalHasPhysicalProduct ? normalizedShipping : null
      }
    });

    await supabase
      .from('orders')
      .update({
        mollie_payment_id: payment.id
      })
      .eq('id', order.id);

    return res.status(200).json({
      checkoutUrl: payment._links.checkout.href,
      orderId: order.id
    });
  } catch (error) {
    console.error('create-payment error:', error);

    return res.status(500).json({
      error: 'Could not create payment.'
    });
  }
}
