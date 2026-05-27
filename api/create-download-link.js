import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function isEmail(value) {
  return typeof value === 'string' && value.includes('@') && value.includes('.');
}
const BUNDLE_ACCESS = {
  a2_sprint_bundle_pdf: [
    'a2_answer_card_pdf',
    'a2_words_theme_pdf',
    'a2_words_frequency_pdf'
  ]
};
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { email, productId } = req.body || {};

    if (!isEmail(email) || !productId) {
      return res.status(400).json({ error: 'Missing email or product.' });
    }

// 1. 检查用户是否真的购买过这个商品，或购买过包含它的套餐
const { data: purchases, error: purchaseError } = await supabase
  .from('purchases')
  .select('*')
  .eq('email', email);

if (purchaseError) throw purchaseError;

const hasDirectPurchase = purchases?.some(function (item) {
  return item.product_id === productId;
});

const hasBundlePurchase = purchases?.some(function (item) {
  const bundleItems = BUNDLE_ACCESS[item.product_id];

  return Array.isArray(bundleItems) && bundleItems.includes(productId);
});

if (!hasDirectPurchase && !hasBundlePurchase) {
  return res.status(403).json({ error: 'No access to this product.' });
}
    // 2. 从 products 表读取这个商品对应的 PDF 路径
    const { data: product, error: productError } = await supabase
      .from('products')
      .select('file_path')
      .eq('id', productId)
      .maybeSingle();

    if (productError) throw productError;

    if (!product || !product.file_path) {
      return res.status(404).json({ error: 'Product file not found.' });
    }

    // 3. 生成 Supabase Storage 临时下载链接
    const { data, error } = await supabase.storage
      .from('digital-products')
      .createSignedUrl(product.file_path, 60 * 5);

    if (error) throw error;

    return res.status(200).json({
      downloadUrl: data.signedUrl
    });

    } catch (error) {
    console.error('create-download-link error:', error);

    return res.status(500).json({
      error: 'Could not create download link.',
      debug: {
        message: error.message,
        name: error.name,
        details: error.details || null,
        hint: error.hint || null,
        code: error.code || null
      }
    });
  }
}
