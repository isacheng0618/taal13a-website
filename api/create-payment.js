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

function isCourseProductFromDb(product) {
  if (!product) return false;

  return (
    product.product_type === 'course' ||
    product.type === 'course' ||
    String(product.id || '').startsWith('course_')
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


    const cleanItems = items
  .map((item) => {
    const parsedQuantity = Number(item.quantity || item.qty || 1);

    return {
      productId: cleanString(
        String(item.productId || item.id || '')
      ),

      variantId:
        cleanString(
          String(item.variantId || item.variant_id || '')
        ) || null,

      quantity: Number.isFinite(parsedQuantity)
        ? Math.max(1, Math.floor(parsedQuantity))
        : 1,

      kind:
        cleanString(
          String(item.kind || 'product')
        ) || 'product'
    };
  })
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


    const variantIds = [
  ...new Set(
    cleanItems
      .map((item) => item.variantId)
      .filter(Boolean)
  )
];

let variants = [];

if (variantIds.length > 0) {
  const { data: variantRows, error: variantError } = await supabase
    .from('product_variants')
    .select(
      'id, product_id, title_zh, title_nl, price_cents, stock_quantity, active'
    )
    .in('id', variantIds)
    .eq('active', true);

  if (variantError) {
    throw variantError;
  }

  if (!variantRows || variantRows.length !== variantIds.length) {
    return res.status(400).json({
      error: 'One or more product variants are unavailable.'
    });
  }

  variants = variantRows;
}

    /*
  汇总同一款式的数量。
  防止同一款式以多行形式出现时，绕过库存检查。
*/
const requestedVariantQuantities = new Map();

for (const item of cleanItems) {
  if (!item.variantId) continue;

  const currentQuantity =
    requestedVariantQuantities.get(item.variantId) || 0;

  requestedVariantQuantities.set(
    item.variantId,
    currentQuantity + item.quantity
  );
}

let totalCents = 0;
const orderItems = [];

for (const item of cleanItems) {
  const product = products.find(
    (productRow) => productRow.id === item.productId
  );

  if (!product) {
    return res.status(400).json({
      error: 'Product not found.'
    });
  }

  const quantity = item.quantity;

  let unitPriceCents = Number(product.price_cents || 0);
  let variantId = null;
  let variantName = null;

  /*
    有 variantId：从 product_variants 读取真实价格和库存。
  */
  if (item.variantId) {
    const variant = variants.find(
      (variantRow) => variantRow.id === item.variantId
    );

    if (!variant) {
      return res.status(400).json({
        error: 'Selected product variant is unavailable.'
      });
    }

    /*
      防止把另一个商品的款式套到当前商品上。
    */
    if (variant.product_id !== product.id) {
      return res.status(400).json({
        error: 'Selected variant does not belong to this product.'
      });
    }

    const requestedQuantity =
      requestedVariantQuantities.get(variant.id) || quantity;

    const stockQuantity = Number(variant.stock_quantity);

    if (
      !Number.isInteger(stockQuantity) ||
      stockQuantity < requestedQuantity
    ) {
      return res.status(400).json({
        error: `Insufficient stock for variant ${variant.id}.`
      });
    }

    unitPriceCents = Number(variant.price_cents || 0);
    variantId = variant.id;

    variantName =
      variant.title_zh ||
      variant.title_nl ||
      variant.id;
  }

  /*
    钥匙扣必须选择款式，不能只使用主商品最低价下单。
  */
  if (
    product.id === 'dutch_keychain_physical' &&
    !variantId
  ) {
    return res.status(400).json({
      error: 'Please select a keychain variant.'
    });
  }

  /*
    最终价格必须来自数据库，并且大于0。
  */
  if (
    !Number.isInteger(unitPriceCents) ||
    unitPriceCents <= 0
  ) {
    return res.status(400).json({
      error: 'Invalid product price.'
    });
  }

  totalCents += unitPriceCents * quantity;

  orderItems.push({
    product_id: product.id,
    quantity,
    unit_price_cents: unitPriceCents,
    variant_id: variantId,
    variant_name: variantName
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

   const hasDigitalProduct = products.some((product) =>
  !isPhysicalProductFromDb(product) && !isCourseProductFromDb(product)
);

if (hasDigitalProduct && !acceptedDigitalDelivery) {
  return res.status(400).json({
    error: 'Please accept the digital delivery consent.'
  });
}
    
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
