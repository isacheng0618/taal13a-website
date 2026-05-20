import { createClient } from '@supabase/supabase-js';
import { createMollieClient } from '@mollie/api-client';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const mollie = createMollieClient({
  apiKey: process.env.MOLLIE_API_KEY
});

function isCourseProduct(product) {
  return (
    product?.product_type === 'course' ||
    product?.type === 'course' ||
    String(product?.id || '').startsWith('course_')
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  try {
    const paymentId = req.body?.id;

    if (!paymentId) {
      return res.status(400).send('Missing payment id');
    }

    const payment = await mollie.payments.get(paymentId);
    const orderId = payment.metadata?.orderId;

    if (!orderId) {
      return res.status(400).send('Missing order id');
    }

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .single();

    if (orderError || !order) {
      return res.status(404).send('Order not found');
    }

    if (order.status === 'paid') {
      return res.status(200).send('Already processed');
    }

    if (payment.status === 'paid') {
      const { error: updateError } = await supabase
        .from('orders')
        .update({
          status: 'paid',
          paid_at: new Date().toISOString()
        })
        .eq('id', orderId);

      if (updateError) throw updateError;

      const { data: items, error: itemsError } = await supabase
        .from('order_items')
        .select(`
          product_id,
          products (
            id,
            type,
            product_type
          )
        `)
        .eq('order_id', orderId);

      if (itemsError) throw itemsError;

      const digitalPurchases = [];
      const coursePurchases = [];

      for (const item of items || []) {
        const product = item.products;

        if (isCourseProduct(product)) {
          coursePurchases.push({
            order_id: orderId,
            course_id: item.product_id,
            email: order.email
          });
        } else {
          digitalPurchases.push({
            user_id: order.user_id || null,
            email: order.email,
            product_id: item.product_id,
            order_id: orderId,
            access_type: 'download'
          });
        }
      }

      if (digitalPurchases.length > 0) {
        const { error: purchaseError } = await supabase
          .from('purchases')
          .insert(digitalPurchases);

        if (purchaseError) throw purchaseError;
      }

      if (coursePurchases.length > 0) {
        const { error: coursePurchaseError } = await supabase
          .from('course_purchases')
          .insert(coursePurchases);

        if (coursePurchaseError) throw coursePurchaseError;
      }

      return res.status(200).send('Payment processed');
    }

    if (['canceled', 'expired', 'failed'].includes(payment.status)) {
      await supabase
        .from('orders')
        .update({ status: payment.status })
        .eq('id', orderId);
    }

    return res.status(200).send('Webhook received');

  } catch (error) {
    console.error('mollie-webhook error:', error);
    return res.status(500).send('Webhook error');
  }
}
