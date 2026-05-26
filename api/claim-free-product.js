
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res){
  if(req.method !== 'POST'){
    return res.status(405).json({error:'Method not allowed'});
  }

  const { email, productId } = req.body;

  if(!email || !productId){
    return res.status(400).json({error:'Missing email or productId'});
  }

  const { data: product, error: productError } = await supabase
    .from('products')
    .select('id, price_cents, active')
    .eq('id', productId)
    .eq('active', true)
    .single();

  if(productError || !product){
    return res.status(404).json({error:'Product not found'});
  }

  if(product.price_cents !== 0){
    return res.status(400).json({error:'This product is not free'});
  }

  const { data: existing } = await supabase
    .from('purchases')
    .select('id')
    .eq('email', email)
    .eq('product_id', productId)
    .maybeSingle();

  if(existing){
    return res.status(200).json({ok:true, alreadyClaimed:true});
  }

  const { error: insertError } = await supabase
    .from('purchases')
    .insert({
      email: email,
      product_id: productId,
      status: 'paid',
      amount_cents: 0,
      currency: 'EUR'
    });

  if(insertError){
    return res.status(500).json({error:insertError.message});
  }

  return res.status(200).json({ok:true});
}
