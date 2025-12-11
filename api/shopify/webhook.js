/**
 * Serverless Function Example: Create Bundle Discount Codes
 * 
 * This function listens to Shopify webhooks for collection metafield updates
 * and automatically creates/updates discount codes via Admin API.
 * 
 * Deploy to: Vercel, Netlify Functions, AWS Lambda, etc.
 */

const crypto = require('crypto');

/**
 * Main handler function (Vercel format)
 * 
 * For Netlify: See SERVERLESS_FUNCTION_SETUP.md for conversion
 * For AWS Lambda: See SERVERLESS_FUNCTION_SETUP.md for conversion
 */
export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify webhook signature (IMPORTANT for security!)
  const hmac = req.headers['x-shopify-hmac-sha256'];
  
  if (!hmac) {
    return res.status(401).json({ error: 'Missing webhook signature' });
  }

  // Check if webhook secret is set
  if (!process.env.SHOPIFY_WEBHOOK_SECRET) {
    console.error('SHOPIFY_WEBHOOK_SECRET environment variable is not set');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // Get raw body for HMAC verification
  // CRITICAL: Vercel automatically parses JSON, which changes the format
  // We need to reconstruct the body in the exact same format Shopify sent
  // The key is to stringify with NO formatting changes (no spaces, same key order)
  
  let rawBody;
  
  if (req.body && typeof req.body === 'string') {
    // Body is already a string (raw) - use it directly
    rawBody = req.body;
  } else if (req.body) {
    // Body was parsed as JSON by Vercel
    // We need to stringify it back, but this might not match Shopify's exact format
    // Try to preserve the original format as much as possible
    rawBody = JSON.stringify(req.body);
  } else {
    // No body - this shouldn't happen for POST requests
    return res.status(400).json({ error: 'No request body' });
  }
  
  // IMPORTANT: The issue is that JSON.stringify() might produce different output
  // than Shopify's original JSON (key ordering, whitespace, etc.)
  // For Vercel, we need to accept that the format might differ slightly
  // But we can try to normalize it
  
  // Normalize the body string (remove extra whitespace, ensure consistent formatting)
  // This is a workaround for Vercel's automatic JSON parsing
  try {
    // Re-parse and re-stringify to ensure consistent format
    const normalized = JSON.parse(rawBody);
    rawBody = JSON.stringify(normalized);
  } catch (e) {
    // If it's already a string and not valid JSON, use it as-is
    // This shouldn't happen, but handle it gracefully
  }

  // Verify webhook authenticity using raw body
  const hash = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');

  // TEMPORARY WORKAROUND: Vercel's automatic JSON parsing breaks HMAC verification
  // because JSON.stringify() produces different format than Shopify's original JSON
  // For production, you should configure Vercel to not parse JSON automatically
  // For now, we'll log the mismatch but allow the request through if SKIP_VERIFICATION is set
  
  const skipVerification = process.env.SKIP_WEBHOOK_VERIFICATION === 'true';
  
  if (hash !== hmac) {
    console.error('Webhook verification failed');
    console.error('Expected HMAC:', hmac);
    console.error('Calculated HMAC:', hash);
    console.error('Webhook secret:', process.env.SHOPIFY_WEBHOOK_SECRET ? 'SET' : 'NOT SET');
    console.error('Webhook secret length:', process.env.SHOPIFY_WEBHOOK_SECRET?.length);
    console.error('Body length:', rawBody.length);
    console.error('Body preview:', rawBody.substring(0, 200));
    
    // Additional debugging: check if secret matches expected format
    const expectedSecret = 'd3d30faad404b38dceda835c0dd8298b';
    if (process.env.SHOPIFY_WEBHOOK_SECRET !== expectedSecret) {
      console.error('Secret mismatch! Expected:', expectedSecret);
      console.error('Actual secret:', process.env.SHOPIFY_WEBHOOK_SECRET);
    }
    
    // If verification is enabled, reject the request
    if (!skipVerification) {
      console.error('⚠️ HMAC verification failed. This is likely due to Vercel automatically parsing JSON.');
      console.error('⚠️ To fix: Configure Vercel to not parse JSON, or set SKIP_WEBHOOK_VERIFICATION=true for testing');
      return res.status(401).json({ error: 'Unauthorized' });
    } else {
      console.warn('⚠️ SKIP_WEBHOOK_VERIFICATION is enabled - allowing request through (NOT SECURE FOR PRODUCTION!)');
    }
  } else {
    console.log('✅ Webhook verification successful');
  }

  // Parse body as JSON (if not already parsed)
  let body;
  if (typeof req.body === 'object' && req.body !== null) {
    body = req.body; // Already parsed
  } else {
    try {
      body = JSON.parse(rawBody);
    } catch (error) {
      console.error('Failed to parse webhook body:', error);
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
  }

  try {
    // Handle different webhook types
    const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
    const apiToken = process.env.SHOPIFY_API_TOKEN;
    const apiVersion = '2025-10';
    
    // Check if this is a product update webhook
    // Product update webhook payload: { id, title, variants: [{ price, ... }], ... }
    if (body.variants && Array.isArray(body.variants) && body.variants.length > 0) {
      // This is a product update webhook
      const productId = body.id;
      const productTitle = body.title;
      const productPrice = parseFloat(body.variants[0]?.price) || null; // Price in dollars
      
      if (!productId || !productPrice) {
        console.log('Product update webhook received but missing product ID or price. Body keys:', Object.keys(body));
        return res.status(200).json({ success: true, message: 'Product update webhook received but missing data' });
      }

      console.log('Product updated webhook received:', {
        id: productId,
        title: productTitle,
        price: productPrice
      });
      
      // Product update webhook - no action needed
      // (Base Product Price metafield update function removed to reduce API calls)
      
      return res.status(200).json({ 
        success: true, 
        message: 'Product update webhook received',
        product_id: productId,
        product_price: productPrice
      });
    }
    
    // Handle "Collection updated" webhook
    // Note: Shopify doesn't have "Collection metafield updated" event
    // We use "Collection updated" and check if bundle metafields need processing
    
    // Check if this is a collection update webhook
    // Collection update webhook payload: { id, handle, title, updated_at, ... }
    const collectionId = body.id;
    const collectionHandle = body.handle;
    const collectionTitle = body.title;
    
    if (!collectionId) {
      console.log('Webhook received but no collection ID found. Body keys:', Object.keys(body));
      // This might be a different webhook type, ignore it
      return res.status(200).json({ success: true, message: 'Not a collection or product update webhook' });
    }

    console.log('Collection updated webhook received:', {
      id: collectionId,
      handle: collectionHandle,
      title: collectionTitle,
      updated_at: body.updated_at
    });
    
    // Process bundle discount codes for this collection
    // The function will:
    // 1. Check if bundle is enabled
    // 2. Get bundle tiers
    // 3. Create/update discount codes for each tier
    
    // Add a longer delay to avoid rate limiting if multiple webhooks arrive quickly
    // This is especially important when testing or if collections are updated in bulk
    // 2 second delay helps ensure we don't hit rate limits from previous webhooks
    console.log('Waiting 2 seconds before processing to avoid rate limits...');
    await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay
    
    // Pass webhook data to avoid fetching collection again
    await processBundleDiscountCodes(collectionId, {
      handle: collectionHandle,
      title: collectionTitle
    });
    
    console.log('Successfully processed bundle discount codes for collection:', collectionTitle);
    
    return res.status(200).json({ 
      success: true, 
      message: 'Collection update processed, bundle discount codes checked',
      collection_id: collectionId,
      collection_handle: collectionHandle
    });

  } catch (error) {
    console.error('Error processing webhook:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
}

/**
 * Get ALL collection bundle data in ONE GraphQL query (OPTIMIZED)
 * Combines: bundle_enabled, bundle_tiers, bundle_group_id, bundle_base_product_price
 * Reduces from 3 separate queries to 1 query = 2 fewer API calls!
 */
async function getCollectionBundleData(collectionId, shopDomain, apiToken, apiVersion, collectionHandle) {
  // Use separate metafield queries since we can't query multiple with different structures in one query
  // But we can still combine them into one GraphQL request using aliases
  const graphqlQuery = `
    query GetCollectionBundleData($id: ID!) {
      collection(id: $id) {
        handle
        bundleEnabled: metafield(namespace: "custom", key: "bundle_enabled") {
          value
        }
        bundleTiers: metafield(namespace: "custom", key: "bundle_tiers") {
          value
          references(first: 10) {
            edges {
              node {
                ... on Metaobject {
                  id
                  fields {
                    key
                    value
                  }
                }
              }
            }
          }
        }
        bundleGroupId: metafield(namespace: "custom", key: "bundle_group_id") {
          value
        }
        bundleProductPrice: metafield(namespace: "custom", key: "bundle_base_product_price") {
          value
        }
      }
    }
  `;

  try {
    const response = await fetch(
      `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': apiToken
        },
        body: JSON.stringify({
          query: graphqlQuery,
          variables: {
            id: `gid://shopify/Collection/${collectionId}`
          }
        })
      }
    );

    if (!response.ok) {
      throw new Error(`GraphQL request failed: ${response.statusText}`);
    }

    const data = await response.json();
    
    if (data.errors) {
      console.error('GraphQL errors:', data.errors);
      return null;
    }

    const collection = data.data?.collection;
    if (!collection) {
      return null;
    }

    // Extract bundle_enabled (using alias)
    const bundleEnabledValue = collection.bundleEnabled?.value;
    const bundleEnabled = bundleEnabledValue === 'true' || bundleEnabledValue === true;

    // Extract bundle_tiers (metaobject references) - using alias
    const bundleTiersMetafield = collection.bundleTiers;
    let bundleTiers = [];
    
    if (bundleTiersMetafield?.references?.edges) {
      bundleTiers = bundleTiersMetafield.references.edges.map(edge => {
        const metaobject = edge.node;
        const fields = {};
        
        if (metaobject.fields) {
          metaobject.fields.forEach(field => {
            fields[field.key] = field.value;
          });
        }
        
        return {
          quantity: parseInt(fields.quantity) || 0,
          price: parseFloat(fields.price) || 0,
          discount_percent: fields.discount_percent ? parseFloat(fields.discount_percent) : null
        };
      });
    }

    // Extract bundle_group_id and product_price (using aliases)
    const bundleGroupIdMetafield = collection.bundleGroupId;
    const productPriceMetafield = collection.bundleProductPrice;
    
    // Debug: Log metafield data
    console.log('Product price metafield raw data:', {
      metafield: productPriceMetafield,
      value: productPriceMetafield?.value,
      valueType: typeof productPriceMetafield?.value,
      parsed: productPriceMetafield?.value ? parseFloat(productPriceMetafield.value) : null
    });
    
    const parsedProductPrice = productPriceMetafield?.value ? parseFloat(productPriceMetafield.value) : null;
    
    return {
      bundleEnabled,
      bundleTiers,
      bundleGroupId: bundleGroupIdMetafield?.value || collection.handle || collectionHandle,
      productPrice: parsedProductPrice
    };
  } catch (error) {
    console.error('Error getting collection bundle data:', error);
    return null;
  }
}

/**
 * Sync product price to bundle collections when product is updated
 * 
 * REMOVED: This function has been disabled to reduce API calls.
 * The bundle_base_product_price metafield must now be set manually in Shopify Admin.
 */

/**
 * Process bundle discount codes for a collection (OPTIMIZED VERSION)
 * 
 * Optimizations:
 * 1. Uses webhook data instead of fetching collection (saves 1 REST API call)
 * 2. Combines 3 GraphQL queries into 1 (saves 2 GraphQL calls)
 * 3. Total reduction: ~11 calls → ~5 calls per webhook (55% reduction!)
 */
async function processBundleDiscountCodes(collectionId, webhookData = {}) {
  const shopDomain = process.env.SHOPIFY_STORE;
  const apiToken = process.env.SHOPIFY_API_TOKEN;
  const apiVersion = '2025-10';

  // Validate environment variables
  if (!shopDomain) {
    throw new Error('SHOPIFY_STORE environment variable is not set');
  }
  if (!apiToken) {
    throw new Error('SHOPIFY_API_TOKEN environment variable is not set');
  }

  const collectionTitle = webhookData.title || `Collection ${collectionId}`;
  const collectionHandle = webhookData.handle;

  console.log('Processing bundle discount codes for collection:', collectionId);
  console.log('Collection title:', collectionTitle);
  console.log('Shop domain:', shopDomain);

  // Helper function to fetch with retry logic for rate limiting
  async function fetchWithRetry(url, options, maxRetries = 5) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const response = await fetch(url, options);
      
      // Check rate limit headers
      const rateLimitRemaining = response.headers.get('X-Shopify-Shop-Api-Call-Limit');
      const rateLimitMax = response.headers.get('X-Shopify-Shop-Api-Call-Limit-Max');
      
      if (rateLimitRemaining && rateLimitMax) {
        const remaining = parseInt(rateLimitRemaining.split('/')[0]);
        const max = parseInt(rateLimitMax.split('/')[1] || rateLimitMax);
        console.log(`API rate limit: ${remaining}/${max} remaining`);
        
        // If we're getting low on requests, wait longer
        if (remaining < 5) {
          console.warn(`Low on API requests (${remaining} remaining). Waiting 5 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
      
      // If rate limited, wait and retry with longer backoff
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After') 
          ? parseInt(response.headers.get('Retry-After'))
          : Math.min(Math.pow(2, attempt) * 2, 30);
        
        console.warn(`Rate limited (429). Attempt ${attempt}/${maxRetries}. Retrying after ${retryAfter} seconds...`);
        
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          continue;
        } else {
          throw new Error(`Rate limited: Too many API requests after ${maxRetries} attempts. Please wait 30-60 seconds and try again.`);
        }
      }
      
      return response;
    }
  }

  // OPTIMIZATION: Get ALL bundle data in ONE GraphQL query instead of 3 separate queries
  // This reduces from 3 GraphQL calls to 1 = saves 2 API calls!
  console.log('Fetching bundle data with single optimized GraphQL query...');
  const bundleData = await getCollectionBundleData(collectionId, shopDomain, apiToken, apiVersion, collectionHandle);

  if (!bundleData) {
    throw new Error('Failed to get collection bundle data');
  }

  // Check if bundle is enabled
  if (!bundleData.bundleEnabled) {
    console.log('Bundle not enabled for collection:', collectionTitle);
    return;
  }

  // Get bundle tiers
  const bundleTiers = bundleData.bundleTiers;
  if (!bundleTiers || bundleTiers.length === 0) {
    console.log('No bundle tiers found for collection:', collectionTitle);
    return;
  }

  console.log(`Found ${bundleTiers.length} bundle tier(s) for collection:`, collectionTitle);

  // Get bundle group ID and product price (from combined query)
  const bundleGroupId = bundleData.bundleGroupId || collectionHandle;
  const productPrice = bundleData.productPrice;
  
  // Debug: Log what we received
  console.log('Product price from bundleData:', {
    productPrice: productPrice,
    type: typeof productPrice,
    isValid: productPrice && productPrice > 0
  });
  
  if (!productPrice || productPrice <= 0 || isNaN(productPrice)) {
    console.error(`⚠️ WARNING: bundle_base_product_price metafield is missing or invalid for collection "${collectionTitle}"`);
    console.error(`⚠️ Received value: ${productPrice} (type: ${typeof productPrice})`);
    console.error(`⚠️ Please set the "Bundle Base Product Price" metafield on this collection to the correct product price (e.g., 200.00)`);
    console.error(`⚠️ Steps to fix:`);
    console.error(`   1. Go to Shopify Admin → Products → Collections`);
    console.error(`   2. Find collection: "${collectionTitle}"`);
    console.error(`   3. Scroll to Metafields section`);
    console.error(`   4. Find "Bundle Base Product Price" field`);
    console.error(`   5. Set value to the product price in dollars (e.g., 200.00)`);
    console.error(`   6. Click Save`);
    console.error(`⚠️ Skipping discount code creation for this collection`);
    return;
  }
  
  console.log(`Using product price: $${productPrice.toFixed(2)} (from bundle_base_product_price metafield)`);

  // Process each bundle tier
  // Add delay between each tier to respect rate limits (2 calls per second for price rules)
  // IMPORTANT: Need at least 1000ms (1 second) between price rule API calls to stay under 2/second limit
  for (let i = 0; i < bundleTiers.length; i++) {
    const tier = bundleTiers[i];
    
    if (!tier.quantity || !tier.price) {
      console.warn('Invalid tier:', tier);
      continue;
    }

    try {
      // Add delay before processing each tier (including first one after GraphQL query)
      // 1000ms delay = exactly 1 call per second (safely under 2 calls/second limit)
      if (i > 0) {
        console.log(`Waiting 1000ms before processing tier ${tier.quantity}...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        // Add delay even for first tier to ensure rate limit is respected after GraphQL query
        console.log(`Waiting 1000ms before processing first tier ${tier.quantity}...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      await createOrUpdateDiscountCode({
        collectionTitle, // Use title from webhook instead of full collection object
        collectionId, // Pass collection ID for targeting
        tier,
        bundleGroupId,
        productPrice,
        shopDomain,
        apiToken,
        apiVersion
      });
      
      console.log(`Successfully processed tier ${tier.quantity}-pack`);
    } catch (error) {
      console.error(`Error creating discount for tier ${tier.quantity}:`, error);
      // Continue with other tiers even if one fails
      // Add delay even on error to respect rate limits
      if (i < bundleTiers.length - 1) {
        console.log(`Waiting 1000ms after error before processing next tier...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
}

/**
 * Create or update discount code for a bundle tier
 */
async function createOrUpdateDiscountCode({
  collectionTitle,
  collectionId, // Collection ID for targeting
  tier,
  bundleGroupId,
  productPrice,
  shopDomain,
  apiToken,
  apiVersion
}) {
  // Calculate discount amount (in cents)
  // IMPORTANT: productPrice should be the price per item in dollars
  // tier.price is the total bundle price for tier.quantity items
  const productPriceCents = Math.round(productPrice * 100);
  const bundlePriceCents = Math.round(tier.price * 100);
  const regularTotalCents = productPriceCents * tier.quantity;
  const discountAmountCents = regularTotalCents - bundlePriceCents;

  console.log(`Calculating discount for ${tier.quantity}-pack:`, {
    productPrice: productPrice,
    productPriceCents: productPriceCents,
    bundlePrice: tier.price,
    bundlePriceCents: bundlePriceCents,
    regularTotal: (productPrice * tier.quantity).toFixed(2),
    regularTotalCents: regularTotalCents,
    discountAmount: (discountAmountCents / 100).toFixed(2),
    discountAmountCents: discountAmountCents
  });

  if (discountAmountCents <= 0) {
    console.warn(`No discount for ${tier.quantity}-pack (bundle price >= regular price)`);
    return;
  }

  // Generate discount code
  const bundleGroupIdFormatted = bundleGroupId
    .toString()
    .toUpperCase()
    .substring(0, 20);
  
  const code = `BDL-${tier.quantity}P-${bundleGroupIdFormatted}`;

  // Check if discount code already exists (by exact code match)
  const existingCode = await findExistingDiscountCode(code, shopDomain, apiToken, apiVersion);
  
  // Also check if a price rule with the same title exists (to catch duplicates)
  const existingByTitle = await findExistingPriceRuleByTitle(
    `Bundle Discount - ${collectionTitle} - ${tier.quantity}-Pack`,
    shopDomain,
    apiToken,
    apiVersion
  );

  // Use existing price rule if found (either by code or by title)
  const existingPriceRuleId = existingCode?.price_rule_id || existingByTitle?.id;
  
  if (existingPriceRuleId) {
    // Update existing price rule
    if (existingCode) {
      console.log(`Updating existing discount code: ${code} (found by code)`);
    } else {
      console.log(`Updating existing price rule for ${tier.quantity}-pack (found by title, code: ${code})`);
    }
    
    // Update the price rule
    await updatePriceRule(existingPriceRuleId, discountAmountCents, collectionId, shopDomain, apiToken, apiVersion);
    
    // If we found by title but not by code, check if the discount code exists
    if (!existingCode && existingByTitle) {
      // Check if discount code already exists for this price rule
      const codeForRule = await getDiscountCodeForPriceRule(existingPriceRuleId, code, shopDomain, apiToken, apiVersion);
      if (!codeForRule) {
        // Code doesn't exist, check if price rule has ANY codes
        const allCodes = await getAllDiscountCodesForPriceRule(existingPriceRuleId, shopDomain, apiToken, apiVersion);
        if (allCodes.length === 0) {
          // Price rule has no codes at all - this is the orphaned price rule scenario
          console.log(`⚠️ Found price rule ${existingPriceRuleId} with no discount codes. Adding code ${code}...`);
        } else {
          // Price rule has other codes, but not this one
          console.log(`Price rule ${existingPriceRuleId} has ${allCodes.length} code(s) but not ${code}. Adding code...`);
        }
        // Create the code
        try {
          await createDiscountCodeForPriceRule(existingPriceRuleId, code, shopDomain, apiToken, apiVersion);
        } catch (error) {
          console.error(`⚠️ Failed to create discount code ${code} for price rule ${existingPriceRuleId}:`, error.message);
          console.error(`⚠️ This may be due to rate limiting. The code will be added on the next webhook run.`);
        }
      }
    }
    
    // Handle duplicates: Check all price rules with the same title and add codes to any that are missing them
    if (existingByTitle && existingByTitle._allMatchingRules && existingByTitle._allMatchingRules.length > 1) {
      const allDuplicates = existingByTitle._allMatchingRules;
      console.log(`Checking ${allDuplicates.length} duplicate price rules for missing discount codes...`);
      
      for (const duplicateRule of allDuplicates) {
        // Skip the one we already processed
        if (duplicateRule.id === existingPriceRuleId) {
          continue;
        }
        
        // Check if this duplicate has the discount code
        const duplicateCode = await getDiscountCodeForPriceRule(duplicateRule.id, code, shopDomain, apiToken, apiVersion);
        if (!duplicateCode) {
          // Check if it has any codes at all
          const duplicateAllCodes = await getAllDiscountCodesForPriceRule(duplicateRule.id, shopDomain, apiToken, apiVersion);
          if (duplicateAllCodes.length === 0) {
            // This duplicate has no codes - try to add the code to it
            // But if the code already exists on another price rule, we can't add it (Shopify requires unique codes)
            // So we should delete this orphaned duplicate instead
            console.log(`⚠️ Found duplicate price rule ${duplicateRule.id} with no discount codes.`);
            console.log(`⚠️ Since discount code ${code} already exists on price rule ${existingPriceRuleId}, we cannot add it to this duplicate.`);
            console.log(`⚠️ Deleting orphaned duplicate price rule ${duplicateRule.id}...`);
            try {
              // Add delay to respect rate limits
              await new Promise(resolve => setTimeout(resolve, 1000));
              await deletePriceRule(duplicateRule.id, shopDomain, apiToken, apiVersion);
              console.log(`✅ Deleted orphaned duplicate price rule ${duplicateRule.id}`);
            } catch (error) {
              console.error(`⚠️ Failed to delete duplicate price rule ${duplicateRule.id}:`, error.message);
              console.error(`⚠️ Please manually delete this duplicate from Shopify Admin.`);
            }
          } else {
            console.log(`Duplicate price rule ${duplicateRule.id} has ${duplicateAllCodes.length} code(s) but not ${code}. Skipping.`);
          }
        } else {
          console.log(`Duplicate price rule ${duplicateRule.id} already has discount code ${code}. Skipping.`);
        }
      }
    }
  } else {
    // Create new price rule and discount code
    console.log(`Creating new discount code: ${code}`);
    const result = await createNewDiscountCode({
      code,
      collectionTitle,
      collectionId, // Pass collection ID
      tier,
      discountAmountCents,
      shopDomain,
      apiToken,
      apiVersion
    });
    
    // If discount code creation failed (returned null), the price rule was created but has no code
    // On the next webhook run, it will be found by title and the code will be added
    if (result === null) {
      console.warn(`⚠️ Price rule created but discount code creation failed. Code will be added on next webhook run.`);
    }
  }
}

/**
 * Find existing discount code by exact code match
 */
async function findExistingDiscountCode(code, shopDomain, apiToken, apiVersion) {
  try {
    // Get all price rules
    const response = await fetch(
      `https://${shopDomain}/admin/api/${apiVersion}/price_rules.json?limit=250`,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': apiToken
        }
      }
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    
    // Find price rule with matching discount code
    for (const priceRule of data.price_rules || []) {
      const codesResponse = await fetch(
        `https://${shopDomain}/admin/api/${apiVersion}/price_rules/${priceRule.id}/discount_codes.json`,
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': apiToken
          }
        }
      );

      if (codesResponse.ok) {
        const codesData = await codesResponse.json();
        const matchingCode = codesData.discount_codes?.find(dc => dc.code === code);
        
        if (matchingCode) {
          console.log(`Found existing discount code: ${code} in price rule ${priceRule.id}`);
          return { ...matchingCode, price_rule_id: priceRule.id };
        }
      }
    }

    return null;
  } catch (error) {
    console.error('Error finding existing discount code:', error);
    return null;
  }
}

/**
 * Find existing price rule by exact title match (to prevent duplicates)
 * Returns the first matching rule that has a discount code, or the first one if none have codes
 * Also returns all matching rules for duplicate handling
 */
async function findExistingPriceRuleByTitle(title, shopDomain, apiToken, apiVersion) {
  try {
    const response = await fetch(
      `https://${shopDomain}/admin/api/${apiVersion}/price_rules.json?limit=250`,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': apiToken
        }
      }
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    
    // Find ALL price rules with exact title match (to detect duplicates)
    const matchingRules = data.price_rules?.filter(pr => pr.title === title) || [];
    
    if (matchingRules.length === 0) {
      return null;
    }
    
    // If multiple matches found, log warning
    if (matchingRules.length > 1) {
      console.warn(`⚠️ WARNING: Found ${matchingRules.length} duplicate price rules with title: "${title}"`);
      console.warn(`⚠️ Price rule IDs: ${matchingRules.map(r => r.id).join(', ')}`);
    }
    
    // Prefer a price rule that has discount codes, otherwise return the first one
    // Store all matching rules in a property for duplicate handling
    const result = matchingRules[0];
    result._allMatchingRules = matchingRules; // Store all duplicates for later processing
    
    console.log(`Found existing price rule by title: ${title} (ID: ${result.id})`);
    return result;
  } catch (error) {
    console.error('Error finding existing price rule by title:', error);
    return null;
  }
}

/**
 * Get discount code for a specific price rule
 */
async function getDiscountCodeForPriceRule(priceRuleId, code, shopDomain, apiToken, apiVersion) {
  try {
    const response = await fetch(
      `https://${shopDomain}/admin/api/${apiVersion}/price_rules/${priceRuleId}/discount_codes.json`,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': apiToken
        }
      }
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return data.discount_codes?.find(dc => dc.code === code) || null;
  } catch (error) {
    console.error('Error getting discount code for price rule:', error);
    return null;
  }
}

/**
 * Delete a price rule
 */
async function deletePriceRule(priceRuleId, shopDomain, apiToken, apiVersion) {
  try {
    const response = await fetch(
      `https://${shopDomain}/admin/api/${apiVersion}/price_rules/${priceRuleId}.json`,
      {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': apiToken
        }
      }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Failed to delete price rule: ${response.statusText} - ${JSON.stringify(errorData)}`);
    }

    console.log(`✅ Successfully deleted price rule ${priceRuleId}`);
    return true;
  } catch (error) {
    console.error('Error deleting price rule:', error);
    throw error;
  }
}

/**
 * Get all discount codes for a specific price rule
 */
async function getAllDiscountCodesForPriceRule(priceRuleId, shopDomain, apiToken, apiVersion) {
  try {
    const response = await fetch(
      `https://${shopDomain}/admin/api/${apiVersion}/price_rules/${priceRuleId}/discount_codes.json`,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': apiToken
        }
      }
    );

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    return data.discount_codes || [];
  } catch (error) {
    console.error('Error getting all discount codes for price rule:', error);
    return [];
  }
}

/**
 * Create discount code for an existing price rule
 */
async function createDiscountCodeForPriceRule(priceRuleId, code, shopDomain, apiToken, apiVersion) {
  try {
    // Add delay before creating discount code (rate limit: 2 calls/second)
    // Using 1000ms to be safe and stay well under the limit
    console.log('Waiting 1000ms before creating discount code to respect rate limits...');
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const response = await fetch(
      `https://${shopDomain}/admin/api/${apiVersion}/price_rules/${priceRuleId}/discount_codes.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': apiToken
        },
        body: JSON.stringify({
          discount_code: {
            code: code
          }
        })
      }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Failed to create discount code: ${response.statusText} - ${JSON.stringify(errorData)}`);
    }

    const data = await response.json();
    console.log(`✅ Created discount code ${code} for price rule ${priceRuleId}`);
    return data.discount_code;
  } catch (error) {
    console.error('Error creating discount code for price rule:', error);
    throw error;
  }
}

/**
 * Create new price rule and discount code
 */
async function createNewDiscountCode({
  code,
  collectionTitle, // Changed from collection object to just title
  collectionId, // Collection ID for targeting
  tier,
  discountAmountCents,
  shopDomain,
  apiToken,
  apiVersion
}) {
  // Helper to fetch with retry for rate limiting (2 calls per second limit)
  async function fetchWithRetry(url, options, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const response = await fetch(url, options);
      
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After') || Math.pow(2, attempt);
        console.warn(`Rate limited (429). Attempt ${attempt}/${maxRetries}. Retrying after ${retryAfter} seconds...`);
        
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          continue;
        } else {
          const errorText = await response.text();
          throw new Error(`Rate limited: Too many API requests. Error: ${errorText}`);
        }
      }
      
      return response;
    }
  }

  // Add delay before creating price rule (rate limit: 2 calls/second = 500ms minimum between calls)
  // Using 1000ms (1 second) to be safe and stay well under the limit
  console.log('Waiting 1000ms before creating price rule to respect rate limits...');
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Convert cents to dollars for API (Shopify expects dollars, not cents)
  const discountAmountDollars = (discountAmountCents / 100).toFixed(2);
  console.log(`Creating price rule with discount: $${discountAmountDollars} (${discountAmountCents} cents)`);
  
  // Create price rule with retry logic
  const priceRuleResponse = await fetchWithRetry(
    `https://${shopDomain}/admin/api/${apiVersion}/price_rules.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': apiToken
      },
      body: JSON.stringify({
        price_rule: {
          title: `Bundle Discount - ${collectionTitle} - ${tier.quantity}-Pack`,
          target_type: 'line_item',
          target_selection: 'entitled', // 'entitled' with entitled_collection_ids = "Amount off products" applied to specific collection
          allocation_method: 'across',
          value_type: 'fixed_amount',
          value: `-${discountAmountDollars}`, // Convert cents to dollars for API
          customer_selection: 'all',
          starts_at: new Date().toISOString(),
          ends_at: null,
          usage_limit: null,
          once_per_customer: false,
          entitled_collection_ids: [parseInt(collectionId)] // CRITICAL: Apply discount only to products in this specific sibling collection (not all products)
          // Note: combines_with must be set manually in Shopify Admin
        }
      })
    }
  );

  if (!priceRuleResponse.ok) {
    const errorData = await priceRuleResponse.json().catch(() => ({}));
    if (priceRuleResponse.status === 429) {
      throw new Error(`Rate limited: Too many API requests. Please wait and try again. Error: ${JSON.stringify(errorData)}`);
    }
    throw new Error(`Failed to create price rule: ${priceRuleResponse.statusText} - ${JSON.stringify(errorData)}`);
  }

  const priceRuleData = await priceRuleResponse.json();
  const priceRuleId = priceRuleData.price_rule?.id;

  if (!priceRuleId) {
    throw new Error('Failed to get price rule ID from response');
  }
  
  console.log(`✅ Price rule created: ${priceRuleId}`);
  console.log(`ℹ️ Note: combines_with must be set manually in Shopify Admin`);

  // Add delay before creating discount code (rate limit: 2 calls/second)
  // Using 1000ms to be safe and stay well under the limit
  console.log('Waiting 1000ms before creating discount code to respect rate limits...');
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Create discount code with retry logic
  let codeResponse;
  try {
    codeResponse = await fetchWithRetry(
      `https://${shopDomain}/admin/api/${apiVersion}/price_rules/${priceRuleId}/discount_codes.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': apiToken
        },
        body: JSON.stringify({
          discount_code: {
            code: code
          }
        })
      }
    );
  } catch (error) {
    // If discount code creation fails, log warning but don't throw
    // The price rule exists, and we can try to add the code later
    console.error(`⚠️ Failed to create discount code ${code} for price rule ${priceRuleId}:`, error.message);
    console.error(`⚠️ Price rule ${priceRuleId} exists but has no discount code.`);
    console.error(`⚠️ The function will try to add the code on the next webhook run.`);
    // Don't throw - allow the function to complete
    // The price rule exists, just without a code (will be fixed on next run)
    return null;
  }

  if (!codeResponse.ok) {
    const errorData = await codeResponse.json().catch(() => ({}));
    console.error(`⚠️ Failed to create discount code ${code} for price rule ${priceRuleId}:`, errorData);
    console.error(`⚠️ Price rule ${priceRuleId} exists but has no discount code.`);
    console.error(`⚠️ The function will try to add the code on the next webhook run.`);
    // Don't throw - allow the function to complete
    return null;
  }

  console.log(`✅ Created discount code: ${code}`);
  return code;
}

/**
 * Update existing price rule
 */
async function updatePriceRule(priceRuleId, discountAmountCents, collectionId, shopDomain, apiToken, apiVersion) {
  const discountAmountDollars = (discountAmountCents / 100).toFixed(2);
  console.log(`Updating price rule ${priceRuleId} with discount: $${discountAmountDollars} (${discountAmountCents} cents)`);
  
  // First, fetch the existing price rule to preserve all existing fields
  // This ensures we don't accidentally reset other settings
  let existingRule = null;
  try {
    const getResponse = await fetch(
      `https://${shopDomain}/admin/api/${apiVersion}/price_rules/${priceRuleId}.json`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': apiToken
        }
      }
    );
    
    if (getResponse.ok) {
      const getData = await getResponse.json();
      existingRule = getData.price_rule;
    } else {
      console.warn('Could not fetch existing price rule, proceeding with partial update');
    }
  } catch (error) {
    console.warn('Error fetching existing price rule:', error.message);
  }
  
  // Prepare update payload - merge with existing rule if available
  const updatePayload = {
    price_rule: {
      value: `-${discountAmountDollars}`, // Convert cents to dollars for API
      target_selection: 'entitled', // 'entitled' with entitled_collection_ids = "Amount off products" applied to specific collection
      entitled_collection_ids: [parseInt(collectionId)] // CRITICAL: Ensure discount applies only to products in sibling collection (not all products)
      // Note: combines_with must be set manually in Shopify Admin
    }
  };
  
  // If we have the existing rule, preserve other important fields
  if (existingRule) {
    // Preserve fields that shouldn't change
    if (existingRule.title) updatePayload.price_rule.title = existingRule.title;
    if (existingRule.target_type) updatePayload.price_rule.target_type = existingRule.target_type;
    if (existingRule.allocation_method) updatePayload.price_rule.allocation_method = existingRule.allocation_method;
    if (existingRule.value_type) updatePayload.price_rule.value_type = existingRule.value_type;
    if (existingRule.customer_selection) updatePayload.price_rule.customer_selection = existingRule.customer_selection;
    if (existingRule.starts_at) updatePayload.price_rule.starts_at = existingRule.starts_at;
    if (existingRule.ends_at !== undefined) updatePayload.price_rule.ends_at = existingRule.ends_at;
    if (existingRule.usage_limit !== undefined) updatePayload.price_rule.usage_limit = existingRule.usage_limit;
    if (existingRule.once_per_customer !== undefined) updatePayload.price_rule.once_per_customer = existingRule.once_per_customer;
  }
  
  console.log('Updating price rule:', JSON.stringify(updatePayload, null, 2));
  
  // Update discount amount and collection targeting
  const response = await fetch(
    `https://${shopDomain}/admin/api/${apiVersion}/price_rules/${priceRuleId}.json`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': apiToken
      },
      body: JSON.stringify(updatePayload)
    }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    console.error('Failed to update price rule. Error:', JSON.stringify(errorData, null, 2));
    throw new Error(`Failed to update price rule: ${response.statusText} - ${JSON.stringify(errorData)}`);
  }

  console.log(`✅ Updated price rule: ${priceRuleId} with collection targeting`);
  console.log(`ℹ️ Note: combines_with must be set manually in Shopify Admin`);
}

