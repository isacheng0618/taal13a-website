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
      return res.status(400).json({
        error: 'Missing email or product.',
        debug: { email, productId }
      });
    }

    // 1. 检查购买记录
    const { data: purchases, error: purchaseError } = await supabase
      .from('purchases')
      .select('product_id, email')
      .eq('email', email);

    if (purchaseError) {
      return res.status(500).json({
        error: 'Could not check purchases.',
        debug: purchaseError
      });
    }

    const hasDirectPurchase = purchases?.some(function (item) {
      return item.product_id === productId;
    });

    const hasBundlePurchase = purchases?.some(function (item) {
      const bundleItems = BUNDLE_ACCESS[item.product_id];
      return Array.isArray(bundleItems) && bundleItems.includes(productId);
    });

    if (!hasDirectPurchase && !hasBundlePurchase) {
      return res.status(403).json({
        error: 'No access to this product.',
        debug: {
          email,
          productId,
          purchases
        }
      });
    }

    // 2. 查 products 表
    const { data: product, error: productError } = await supabase
      .from('products')
      .select('id, file_path')
      .eq('id', productId)
      .maybeSingle();

    if (productError) {
      return res.status(500).json({
        error: 'Could not read product.',
        debug: productError
      });
    }

    if (!product || !product.file_path) {
      return res.status(404).json({
        error: 'Product file not found.',
        debug: {
          productId,
          product
        }
      });
    }

    // 3. 生成下载链接
    const { data, error } = await supabase.storage
      .from('digital-products')
      .createSignedUrl(product.file_path, 60 * 5);

    if (error) {
      return res.status(500).json({
        error: 'Could not create signed URL.',
        debug: {
          storageError: error,
          bucket: 'digital-products',
          filePath: product.file_path
        }
      });
    }

    if (!data?.signedUrl) {
      return res.status(500).json({
        error: 'Signed URL missing.',
        debug: {
          data,
          bucket: 'digital-products',
          filePath: product.file_path
        }
      });
    }

    return res.status(200).json({
      downloadUrl: data.signedUrl,
      debug: {
        productId,
        filePath: product.file_path
      }
    });

  } catch (error) {
    console.error('create-download-link fatal error:', error);

    return res.status(500).json({
      error: 'Could not create download link.',
      debug: {
        message: error.message,
        name: error.name,
        code: error.code || null,
        details: error.details || null,
        hint: error.hint || null
      }
    });
  }
}
