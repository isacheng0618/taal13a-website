import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { email, productId } = req.body || {};

    if (!email || !productId) {
      return res.status(400).json({ error: 'Missing email or productId' });
    }

    // 1. 检查商品是否存在、是否启用、是否免费
    const { data: product, error: productError } = await supabase
      .from('products')
      .select('id, price_cents, active')
      .eq('id', productId)
      .eq('active', true)
      .maybeSingle();

    if (productError) {
      return res.status(500).json({ error: productError.message });
    }

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    if (product.price_cents !== 0) {
      return res.status(400).json({ error: 'This product is not free' });
    }

    // 2. 检查是否已经领取过
    const { data: existing, error: existingError } = await supabase
      .from('purchases')
      .select('id')
      .eq('email', email)
      .eq('product_id', productId)
      .maybeSingle();

    if (existingError) {
      return res.status(500).json({ error: existingError.message });
    }

    if (existing) {
      return res.status(200).json({
        ok: true,
        alreadyClaimed: true
      });
    }

    // 3. 写入免费领取记录
    const { error: insertError } = await supabase
      .from('purchases')
      .insert({
        email: email,
        product_id: productId,
        status: 'paid',
        amount_cents: 0,
        currency: 'EUR',
        access_type: 'free'
      });

    if (insertError) {
      return res.status(500).json({ error: insertError.message });
    }

    return res.status(200).json({ ok: true });

  } catch (error) {
    console.error('claim-free-product error:', error);
    return res.status(500).json({
      error: 'Could not claim free product'
    });
  }
}
