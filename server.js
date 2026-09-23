const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const AMAZON_AFFILIATE_TAG = process.env.AMAZON_AFFILIATE_TAG || '';

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// =========================================================
// Browser-like headers
// =========================================================

function getHeaders() {
    return {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept':
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1'
    };
}

function extractASIN(url) {
    if (!url) return null;

    const patterns = [
        /\/dp\/([A-Z0-9]{10})(?:[/?&]|$)/i,
        /\/gp\/product\/([A-Z0-9]{10})(?:[/?&]|$)/i,
        /\/product\/([A-Z0-9]{10})(?:[/?&]|$)/i,
        /\/ASIN\/([A-Z0-9]{10})(?:[/?&]|$)/i
    ];

    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1].toUpperCase();
    }

    return null;
}

async function fetchViaJina(url) {
    try {
        const response = await axios.get(`https://r.jina.ai/${url}`, {
            headers: {
                Accept: 'application/json',
                'X-Return-Format': 'markdown'
            },
            timeout: 15000
        });

        const responseData = response.data?.data || response.data || {};
        const markdownContent = responseData.content || '';
        const title = responseData.title || '';

        let price = '';

        const priceMatch = markdownContent.match(
            /(?:₹|INR|\bRs\.?)\s*([0-9,]+)/i
        );

        if (priceMatch && priceMatch[1]) {
            price = priceMatch[1].replace(/,/g, '');
        }

        return {
            title,
            price,
            image: ''
        };
    } catch (error) {
        console.error('Jina fallback error:', error.message);
        return null;
    }
}

// =========================================================
// Generic helpers
// =========================================================

function cleanText(value) {
    return String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim();
}

function cleanPrice(value) {
    if (value === undefined || value === null) return '';

    const text = cleanText(value);

    const match = text.match(
        /(?:₹|INR|Rs\.?)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i
    );

    if (!match) return '';

    const numeric = Number(match[1].replace(/,/g, ''));

    if (!Number.isFinite(numeric) || numeric <= 0) return '';

    return `₹${Math.round(numeric)}`;
}

function cleanImageUrl(value) {
    if (!value) return '';

    let url = cleanText(value)
        .replace(/^["']|["']$/g, '');

    if (url.startsWith('//')) {
        url = `https:${url}`;
    }

    if (!/^https?:\/\//i.test(url)) return '';

    if (
        url.includes('data:image') ||
        url.includes('googleusercontent.com/s2/favicons')
    ) {
        return '';
    }

    return url;
}

function uniqueStrings(values) {
    const seen = new Set();
    const output = [];

    for (const value of values || []) {
        const item = cleanText(value);

        if (!item || seen.has(item)) continue;

        seen.add(item);
        output.push(item);
    }

    return output;
}

function uniqueImages(values) {
    const seen = new Set();
    const output = [];

    for (const value of values || []) {
        const item = cleanImageUrl(value);

        if (!item || seen.has(item)) continue;

        seen.add(item);
        output.push(item);
    }

    return output;
}

function addIfUsefulImage(list, value) {
    const image = cleanImageUrl(value);

    if (image) {
        list.push(image);
    }
}

function isLikelyColorName(value) {
    const text = cleanText(value).toLowerCase();

    if (!text || text.length > 40) return false;

    const colors = [
        'black',
        'white',
        'red',
        'blue',
        'green',
        'yellow',
        'pink',
        'purple',
        'violet',
        'orange',
        'brown',
        'beige',
        'cream',
        'grey',
        'gray',
        'gold',
        'silver',
        'maroon',
        'navy',
        'magenta',
        'peach',
        'coral',
        'wine',
        'mustard',
        'teal',
        'turquoise',
        'lavender',
        'multicolor',
        'multi color',
        'multicolour',
        'sky blue',
        'dark blue',
        'light blue',
        'dark green',
        'light green',
        'dark pink',
        'light pink',
        'off white'
    ];

    return colors.some(
        color =>
            text === color ||
            text.includes(color)
    );
}

function isLikelySizeName(value) {
    const text = cleanText(value).toUpperCase();

    if (!text || text.length > 20) return false;

    return /^(XXS|XS|S|M|L|XL|XXL|XXXL|XXXXL|\d{1,3}|FREE SIZE|FREE|SMALL|MEDIUM|LARGE|ONE SIZE)$/i.test(
        text
    );
}

function normalizeSize(value, price) {
    if (!value) return null;

    const name = cleanText(
        typeof value === 'object'
            ? value.name ??
              value.label ??
              value.value ??
              value.size
            : value
    );

    if (!name) return null;

    const result = {
        name,
        price: cleanPrice(
            typeof value === 'object'
                ? value.price ??
                  value.sellingPrice ??
                  value.salePrice ??
                  value.amount ??
                  price
                : price
        )
    };

    if (!result.price) {
        delete result.price;
    }

    return result;
}

function getObjectImages(obj) {
    const images = [];

    if (!obj || typeof obj !== 'object') {
        return images;
    }

    const directKeys = [
        'image',
        'imageUrl',
        'imageURL',
        'src',
        'url',
        'thumbnail',
        'thumbnailUrl',
        'mainImage',
        'primaryImage',
        'imageSrc',
        'image_url'
    ];

    for (const key of directKeys) {
        if (typeof obj[key] === 'string') {
            addIfUsefulImage(images, obj[key]);
        }
    }

    const arrayKeys = [
        'images',
        'imageUrls',
        'imageURLs',
        'media',
        'gallery',
        'galleryImages',
        'photos',
        'productImages'
    ];

    for (const key of arrayKeys) {
        const value = obj[key];

        if (!Array.isArray(value)) continue;

        for (const item of value) {
            if (typeof item === 'string') {
                addIfUsefulImage(images, item);
            } else if (
                item &&
                typeof item === 'object'
            ) {
                for (const directKey of directKeys) {
                    if (
                        typeof item[directKey] ===
                        'string'
                    ) {
                        addIfUsefulImage(
                            images,
                            item[directKey]
                        );
                    }
                }
            }
        }
    }

    return uniqueImages(images);
}

function objectLooksLikeProduct(obj) {
    if (
        !obj ||
        typeof obj !== 'object' ||
        Array.isArray(obj)
    ) {
        return false;
    }

    const keys = Object.keys(obj).map(key =>
        key.toLowerCase()
    );

    const hasName = keys.some(key =>
        [
            'name',
            'title',
            'productname',
            'producttitle'
        ].includes(key)
    );

    const hasImage = keys.some(key =>
        [
            'image',
            'imageurl',
            'images',
            'imageurls',
            'thumbnail',
            'thumbnailurl',
            'gallery',
            'media'
        ].includes(key)
    );

    const hasPrice = keys.some(key =>
        [
            'price',
            'sellingprice',
            'saleprice',
            'discountedprice',
            'amount',
            'mrp'
        ].includes(key)
    );

    return hasName && (hasImage || hasPrice);
}

function safeJsonParse(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function collectJsonObjectsFromHtml($) {
    const objects = [];

    $('script').each((index, element) => {
        const text = $(element).html();

        if (!text || text.length < 2) return;

        const type = (
            $(element).attr('type') || ''
        ).toLowerCase();

        if (
            type.includes('json') ||
            type.includes('ld+json') ||
            text.includes('__NEXT_DATA__') ||
            text.includes('__INITIAL_STATE__') ||
            text.includes('__PRELOADED_STATE__') ||
            text.includes('productName') ||
            text.includes('sellingPrice') ||
            text.includes('productDetails')
        ) {
            const parsed = safeJsonParse(
                text.trim()
            );

            if (parsed) {
                objects.push(parsed);
            }

            const assignments = [
                '__NEXT_DATA__',
                '__INITIAL_STATE__',
                '__PRELOADED_STATE__'
            ];

            for (const assignment of assignments) {
                const pattern = new RegExp(
                    `${assignment}\\s*=\\s*(\\{[\\s\\S]*?\\})\\s*;?`,
                    'm'
                );

                const match = text.match(pattern);

                if (match) {
                    const value = safeJsonParse(
                        match[1]
                    );

                    if (value) {
                        objects.push(value);
                    }
                }
            }
        }
    });

    return objects;
}

function walkObjects(
    value,
    callback,
    depth = 0,
    seen = new Set()
) {
    if (
        depth > 14 ||
        value === null ||
        value === undefined
    ) {
        return;
    }

    if (typeof value !== 'object') return;

    if (seen.has(value)) return;

    seen.add(value);

    callback(value);

    if (Array.isArray(value)) {
        for (const item of value) {
            walkObjects(
                item,
                callback,
                depth + 1,
                seen
            );
        }

        return;
    }

    for (const key of Object.keys(value)) {
        walkObjects(
            value[key],
            callback,
            depth + 1,
            seen
        );
    }
}

function getFirstValue(obj, keys) {
    if (
        !obj ||
        typeof obj !== 'object'
    ) {
        return '';
    }

    const lowerMap = new Map(
        Object.keys(obj).map(key => [
            key.toLowerCase(),
            key
        ])
    );

    for (const wanted of keys) {
        const actual = lowerMap.get(
            wanted.toLowerCase()
        );

        if (actual !== undefined) {
            const value = obj[actual];

            if (
                typeof value === 'string' ||
                typeof value === 'number'
            ) {
                return value;
            }
        }
    }

    return '';
}

function getNestedArrays(obj, keys) {
    if (
        !obj ||
        typeof obj !== 'object'
    ) {
        return [];
    }

    const arrays = [];

    for (const key of Object.keys(obj)) {
        if (
            !keys.includes(
                key.toLowerCase()
            )
        ) {
            continue;
        }

        if (Array.isArray(obj[key])) {
            arrays.push(obj[key]);
        }
    }

    return arrays;
}

// =========================================================
// Meesho extraction
// =========================================================

function extractMeeshoStructuredData(
    $,
    finalUrl
) {
    const jsonRoots =
        collectJsonObjectsFromHtml($);

    const allImages = [];
    const candidates = [];
    const variantCandidates = [];
    const sizeCandidates = [];

    for (const root of jsonRoots) {
        walkObjects(root, obj => {
            if (
                objectLooksLikeProduct(obj)
            ) {
                candidates.push(obj);
            }

            const keys = Object.keys(obj).map(
                key => key.toLowerCase()
            );

            const hasColor =
                keys.some(key =>
                    [
                        'color',
                        'colour',
                        'colorname',
                        'colourname',
                        'variantname'
                    ].includes(key)
                );

            const hasVariantPrice =
                keys.some(key =>
                    [
                        'price',
                        'sellingprice',
                        'saleprice',
                        'discountedprice',
                        'amount'
                    ].includes(key)
                );

            if (
                hasColor &&
                hasVariantPrice
            ) {
                variantCandidates.push(obj);
            }

            const hasSize =
                keys.some(key =>
                    [
                        'size',
                        'sizename',
                        'sizevalue'
                    ].includes(key)
                );

            if (
                hasSize &&
                hasVariantPrice
            ) {
                sizeCandidates.push(obj);
            }

            for (
                const image of getObjectImages(obj)
            ) {
                allImages.push(image);
            }
        });
    }

    const ogTitle =
        $('meta[property="og:title"]').attr(
            'content'
        ) ||
        $('meta[name="twitter:title"]').attr(
            'content'
        ) ||
        $('h1').first().text().trim() ||
        '';

    const ogImage =
        $('meta[property="og:image"]').attr(
            'content'
        ) ||
        $('meta[property="og:image:secure_url"]').attr(
            'content'
        ) ||
        $('meta[name="twitter:image"]').attr(
            'content'
        ) ||
        '';

    const bodyText = cleanText(
        $('body').text()
    );

    let title = cleanText(ogTitle);
    let price = '';

    for (const candidate of candidates) {
        if (!title) {
            title = cleanText(
                getFirstValue(
                    candidate,
                    [
                        'name',
                        'title',
                        'productName',
                        'productTitle'
                    ]
                )
            );
        }

        if (!price) {
            price = cleanPrice(
                getFirstValue(
                    candidate,
                    [
                        'sellingPrice',
                        'salePrice',
                        'discountedPrice',
                        'price',
                        'amount',
                        'mrp'
                    ]
                )
            );
        }
    }

    if (!price) {
        const priceMatch =
            bodyText.match(
                /(?:₹|INR|Rs\.?)\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i
            );

        if (priceMatch) {
            price = cleanPrice(
                priceMatch[1]
            );
        }
    }

    addIfUsefulImage(
        allImages,
        ogImage
    );

    const generalImages =
        uniqueImages([
            ogImage,
            ...allImages
        ]).slice(0, 30);

    const colorMap = new Map();

    for (
        const candidate of variantCandidates
    ) {
        const colorName = cleanText(
            getFirstValue(
                candidate,
                [
                    'colorName',
                    'colourName',
                    'color',
                    'colour',
                    'variantName'
                ]
            )
        );

        if (
            !colorName ||
            !isLikelyColorName(colorName)
        ) {
            continue;
        }

        const colorPrice =
            cleanPrice(
                getFirstValue(
                    candidate,
                    [
                        'sellingPrice',
                        'salePrice',
                        'discountedPrice',
                        'price',
                        'amount'
                    ]
                )
            );

        const images =
            getObjectImages(candidate);

        const key =
            colorName.toLowerCase();

        if (!colorMap.has(key)) {
            colorMap.set(key, {
                name: colorName,
                image:
                    images[0] || '',
                images,
                price: colorPrice,
                sizes: []
            });
        } else {
            const current =
                colorMap.get(key);

            if (
                !current.image &&
                images[0]
            ) {
                current.image =
                    images[0];
            }

            current.images =
                uniqueImages([
                    ...current.images,
                    ...images
                ]);

            if (
                !current.price &&
                colorPrice
            ) {
                current.price =
                    colorPrice;
            }
        }

        const candidateSizeArrays =
            getNestedArrays(
                candidate,
                [
                    'sizes',
                    'sizevariants',
                    'sizeoptions',
                    'sizeoptionsdata'
                ]
            );

        for (
            const sizeArray of candidateSizeArrays
        ) {
            for (
                const sizeItem of sizeArray
            ) {
                const normalized =
                    normalizeSize(
                        sizeItem,
                        colorPrice
                    );

                if (
                    normalized &&
                    normalized.name &&
                    (
                        !isLikelySizeName(
                            normalized.name
                        ) ||
                        sizeItem?.price ||
                        sizeItem?.sellingPrice ||
                        sizeItem?.salePrice
                    )
                ) {
                    colorMap
                        .get(key)
                        .sizes
                        .push(normalized);
                }
            }
        }

        const directSize =
            getFirstValue(
                candidate,
                [
                    'sizeName',
                    'sizeValue',
                    'size'
                ]
            );

        if (
            directSize &&
            isLikelySizeName(
                directSize
            )
        ) {
            const normalized =
                normalizeSize(
                    directSize,
                    colorPrice
                );

            if (normalized) {
                colorMap
                    .get(key)
                    .sizes
                    .push(normalized);
            }
        }
    }

    for (
        const candidate of candidates
    ) {
        const arrays =
            getNestedArrays(
                candidate,
                [
                    'sizes',
                    'sizevariants',
                    'sizeoptions',
                    'sizeoptionsdata'
                ]
            );

        for (
            const array of arrays
        ) {
            for (
                const item of array
            ) {
                const normalized =
                    normalizeSize(
                        item,
                        price
                    );

                if (
                    normalized &&
                    (
                        isLikelySizeName(
                            normalized.name
                        ) ||
                        item?.price ||
                        item?.sellingPrice ||
                        item?.salePrice
                    )
                ) {
                    sizeCandidates.push(
                        item
                    );
                }
            }
        }
    }

    const topSizes = [];

    for (
        const item of sizeCandidates
    ) {
        const normalized =
            normalizeSize(
                item,
                price
            );

        if (!normalized) continue;

        if (
            !topSizes.some(
                existing =>
                    existing.name.toLowerCase() ===
                    normalized.name.toLowerCase()
            )
        ) {
            topSizes.push(
                normalized
            );
        }
    }

    const colors =
        [...colorMap.values()]
            .map(color => {
                color.images =
                    uniqueImages([
                        color.image,
                        ...color.images
                    ]);

                color.image =
                    color.images[0] || '';

                color.sizes =
                    color.sizes
                        .filter(Boolean)
                        .filter(
                            (
                                size,
                                index,
                                arr
                            ) =>
                                arr.findIndex(
                                    x =>
                                        x.name.toLowerCase() ===
                                        size.name.toLowerCase()
                                ) === index
                        );

                if (!color.price) {
                    delete color.price;
                }

                if (
                    !color.sizes.length
                ) {
                    delete color.sizes;
                }

                return color;
            })
            .filter(
                color =>
                    color.name &&
                    color.image
            );

    const descriptionParts = [];

    for (
        const candidate of candidates
    ) {
        const description =
            cleanText(
                getFirstValue(
                    candidate,
                    [
                        'description',
                        'shortDescription',
                        'productDescription'
                    ]
                )
            );

        if (
            description &&
            description.length > 15 &&
            description.length < 500
        ) {
            descriptionParts.push(
                description
            );
        }
    }

    const description =
        uniqueStrings(
            descriptionParts
        )[0] ||
        `${title || 'Product'} available in selected variants.`;

    return {
        title,
        price,
        images: generalImages,
        description,
        colors,
        sizes: topSizes,
        finalUrl
    };
}

function extractMeeshoFallbackFromText(
    $,
    current
) {
    const bodyText = cleanText(
        $('body').text()
    );

    if (!current.title) {
        current.title =
            $('meta[property="og:title"]').attr(
                'content'
            ) ||
            $('h1').first().text().trim() ||
            '';
    }

    if (!current.price) {
        const match =
            bodyText.match(
                /(?:₹|INR|Rs\.?)\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i
            );

        if (match) {
            current.price =
                cleanPrice(
                    match[1]
                );
        }
    }

    const imageUrls = [];

    $('img').each(
        (index, element) => {
            addIfUsefulImage(
                imageUrls,
                $(element).attr(
                    'src'
                ) ||
                $(element).attr(
                    'data-src'
                ) ||
                $(element).attr(
                    'data-lazy-src'
                )
            );
        }
    );

    current.images =
        uniqueImages([
            ...(current.images || []),
            ...imageUrls
        ]).slice(0, 30);

    return current;
}

async function extractMeeshoProduct(
    html,
    finalUrl
) {
    const $ = cheerio.load(html);

    let data =
        extractMeeshoStructuredData(
            $,
            finalUrl
        );

    data =
        extractMeeshoFallbackFromText(
            $,
            data
        );

    if (
        !data.title &&
        !data.images.length &&
        !data.price
    ) {
        try {
            const jina =
                await fetchViaJina(
                    finalUrl
                );

            if (jina) {
                data.title =
                    jina.title ||
                    data.title;

                data.price =
                    cleanPrice(
                        jina.price
                    ) ||
                    data.price;
            }
        } catch (error) {
            console.error(
                'Meesho Jina fallback error:',
                error.message
            );
        }
    }

    if (
        !data.title &&
        data.images.length
    ) {
        data.title =
            'Meesho Product';
    }

    if (
        !data.images.length &&
        data.title
    ) {
        const ogImage =
            $('meta[property="og:image"]').attr(
                'content'
            ) || '';

        if (ogImage) {
            data.images = [
                ogImage
            ];
        }
    }

    return data;
}

// =========================================================
// Health
// =========================================================

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp:
            new Date().toISOString()
    });
});

// =========================================================
// Product extraction
// =========================================================

app.get(
    '/api/extract-product',
    async (req, res) => {
        const rawUrl =
            req.query.url;

        if (
            !rawUrl ||
            !/^https?:\/\//i.test(
                rawUrl
            )
        ) {
            return res.status(400).json({
                success: false,
                error:
                    'Invalid URL provided.'
            });
        }

        try {
            let finalUrl =
                rawUrl;

            let response =
                null;

            try {
                response =
                    await axios.get(
                        rawUrl,
                        {
                            headers:
                                getHeaders(),
                            timeout:
                                20000,
                            maxRedirects:
                                10,
                            validateStatus:
                                () => true
                        }
                    );

                if (
                    response.request &&
                    response.request.res &&
                    response.request.res
                        .responseUrl
                ) {
                    finalUrl =
                        response.request.res
                            .responseUrl;
                }
            } catch (error) {
                console.error(
                    'Initial URL fetch error:',
                    error.message
                );

                if (
                    error.request &&
                    error.request.res &&
                    error.request.res
                        .responseUrl
                ) {
                    finalUrl =
                        error.request.res
                            .responseUrl;
                } else {
                    throw new Error(
                        'Unable to reach the provided URL. The website may be blocking the request.'
                    );
                }
            }

            const lowerUrl =
                finalUrl.toLowerCase();

            const isAmazon =
                lowerUrl.includes(
                    'amazon.'
                ) ||
                lowerUrl.includes(
                    'amzn.'
                );

            const isMeesho =
                lowerUrl.includes(
                    'meesho.com'
                ) ||
                lowerUrl.includes(
                    'link.meesho.co'
                );

            if (
                !isAmazon &&
                !isMeesho
            ) {
                return res.status(400).json({
                    success: false,
                    error:
                        'Only Amazon and Meesho URLs are supported.'
                });
            }

            // =====================================================
            // AMAZON — EXISTING LOGIC
            // =====================================================

            if (isAmazon) {
                const extractedData = {
                    title: '',
                    price: '',
                    image: '',
                    finalUrl,
                    asin: null,
                    affiliateUrl:
                        finalUrl
                };

                if (
                    response &&
                    typeof response.data ===
                        'string' &&
                    response.data.length >
                        0
                ) {
                    const $ =
                        cheerio.load(
                            response.data
                        );

                    const pageTitle =
                        $('title')
                            .text()
                            .trim()
                            .toLowerCase();

                    const isAmazonBotPage =
                        pageTitle.includes(
                            'robot check'
                        ) ||
                        pageTitle.includes(
                            'captcha'
                        ) ||
                        pageTitle.includes(
                            'sorry'
                        ) ||
                        $(
                            'form[action="/errors/validateCaptcha"]'
                        ).length > 0;

                    if (
                        isAmazonBotPage
                    ) {
                        console.log(
                            'Amazon bot page detected. Trying Jina...'
                        );

                        const jinaData =
                            await fetchViaJina(
                                finalUrl
                            );

                        if (jinaData) {
                            extractedData.title =
                                jinaData.title ||
                                '';

                            extractedData.price =
                                jinaData.price ||
                                '';

                            extractedData.image =
                                jinaData.image ||
                                '';
                        }
                    } else {
                        extractedData.title =
                            $(
                                '#productTitle'
                            )
                                .text()
                                .trim() ||
                            $(
                                'meta[property="og:title"]'
                            ).attr(
                                'content'
                            ) ||
                            $('h1')
                                .first()
                                .text()
                                .trim() ||
                            '';

                        const priceText =
                            $(
                                '.a-price-whole'
                            )
                                .first()
                                .text()
                                .trim() ||
                            $(
                                '#priceblock_ourprice'
                            )
                                .first()
                                .text()
                                .trim() ||
                            $(
                                '#priceblock_dealprice'
                            )
                                .first()
                                .text()
                                .trim() ||
                            $(
                                '.a-color-price'
                            )
                                .first()
                                .text()
                                .trim() ||
                            '';

                        extractedData.price =
                            priceText.replace(
                                /[^\d]/g,
                                ''
                            );

                        const dynamicImgStr =
                            $(
                                '#landingImage'
                            ).attr(
                                'data-a-dynamic-image'
                            ) ||
                            $(
                                '#imgBlkFront'
                            ).attr(
                                'data-a-dynamic-image'
                            ) ||
                            '';

                        if (
                            dynamicImgStr
                        ) {
                            try {
                                const images =
                                    JSON.parse(
                                        dynamicImgStr
                                    );

                                const imageUrls =
                                    Object.keys(
                                        images
                                    );

                                if (
                                    imageUrls.length >
                                    0
                                ) {
                                    extractedData.image =
                                        imageUrls[0];
                                }
                            } catch (
                                error
                            ) {
                                console.log(
                                    'Dynamic image JSON parse failed.'
                                );
                            }
                        }

                        if (
                            !extractedData.image
                        ) {
                            extractedData.image =
                                $(
                                    'meta[property="og:image"]'
                                ).attr(
                                    'content'
                                ) ||
                                $(
                                    'meta[property="og:image:secure_url"]'
                                ).attr(
                                    'content'
                                ) ||
                                '';
                        }
                    }
                }

                extractedData.asin =
                    extractASIN(
                        finalUrl
                    );

                if (
                    extractedData.asin
                ) {
                    const tag =
                        AMAZON_AFFILIATE_TAG.trim();

                    const tagString =
                        tag
                            ? `?tag=${encodeURIComponent(tag)}`
                            : '';

                    extractedData.affiliateUrl =
                        `https://www.amazon.in/dp/${extractedData.asin}${tagString}`;

                    if (
                        !extractedData.image
                    ) {
                        extractedData.image =
                            `https://images-na.ssl-images-amazon.com/images/P/${extractedData.asin}.01._SCLZZZZZZZ_SX900_.jpg`;
                    }
                }

                if (
                    extractedData.price
                ) {
                    const numericPrice =
                        parseFloat(
                            String(
                                extractedData.price
                            ).replace(
                                /[^\d.]/g,
                                ''
                            )
                        );

                    if (
                        Number.isFinite(
                            numericPrice
                        ) &&
                        numericPrice > 20
                    ) {
                        extractedData.price =
                            `₹${Math.round(
                                numericPrice
                            )}`;
                    } else {
                        extractedData.price =
                            '';
                    }
                }

                if (
                    !extractedData.title &&
                    !extractedData.image &&
                    !extractedData.price
                ) {
                    return res.status(422).json({
                        success: false,
                        error:
                            'Product details could not be extracted. The website may be blocking automated access.',
                        finalUrl
                    });
                }

                return res.json({
                    success: true,
                    platform:
                        'amazon',
                    data:
                        extractedData
                });
            }

            // =====================================================
            // MEESHO
            // =====================================================

            if (
                !response ||
                typeof response.data !==
                    'string' ||
                !response.data.length
            ) {
                return res.status(422).json({
                    success: false,
                    error:
                        'Meesho did not return readable product HTML. Try opening the normal meesho.com product link instead of a short share link.',
                    finalUrl
                });
            }

            const meeshoData =
                await extractMeeshoProduct(
                    response.data,
                    finalUrl
                );

            if (
                !meeshoData.title &&
                !meeshoData.images.length &&
                !meeshoData.price
            ) {
                return res.status(422).json({
                    success: false,
                    error:
                        'Meesho product details could not be extracted. The page may be blocking automated access or hiding product data behind JavaScript.',
                    finalUrl
                });
            }

            return res.json({
                success: true,
                platform:
                    'meesho',
                data:
                    meeshoData
            });
        } catch (error) {
            console.error(
                'Extraction Error:',
                error.message
            );

            return res.status(500).json({
                success: false,
                error:
                    error.message ||
                    'Server error occurred during extraction.'
            });
        }
    }
);

// =========================================================
// SHREE STORE — GitHub Configuration
// =========================================================

const GITHUB_OWNER =
    process.env.GITHUB_OWNER ||
    'everythinghere99';

const GITHUB_REPO =
    process.env.GITHUB_REPO ||
    'everythinghere99.github.io';

const GITHUB_BRANCH =
    process.env.GITHUB_BRANCH ||
    'main';

const GITHUB_FILE_PATH =
    process.env.GITHUB_FILE_PATH ||
    'script.js';

const GITHUB_TOKEN =
    process.env.GITHUB_TOKEN ||
    '';

const ADMIN_KEY =
    process.env.ADMIN_KEY ||
    '';

// =========================================================
// Public GitHub Raw URL
// =========================================================

function getPublicGitHubRawUrl() {
    const encodedPath =
        GITHUB_FILE_PATH
            .split('/')
            .map(part =>
                encodeURIComponent(part)
            )
            .join('/');

    return (
        `https://raw.githubusercontent.com/` +
        `${GITHUB_OWNER}/` +
        `${GITHUB_REPO}/` +
        `${GITHUB_BRANCH}/` +
        encodedPath
    );
}

// =========================================================
// Product Description Generator
// =========================================================

function makeProductDescription(
    name
) {
    const title =
        String(
            name || 'Product'
        )
            .replace(
                /\s+/g,
                ' '
            )
            .trim();

    const lower =
        title.toLowerCase();

    if (
        lower.includes('watch') ||
        lower.includes('smartwatch')
    ) {
        return `Smart ${title} with useful everyday features and a stylish, convenient design.`;
    }

    if (
        lower.includes('dress') ||
        lower.includes('kurti') ||
        lower.includes('shirt') ||
        lower.includes('top') ||
        lower.includes('pant') ||
        lower.includes('jogger') ||
        lower.includes('wear')
    ) {
        return `Stylish ${title} designed for a comfortable fit and an easy everyday look.`;
    }

    if (
        lower.includes('shoe') ||
        lower.includes('sandal') ||
        lower.includes('slipper')
    ) {
        return `Comfortable ${title} made for everyday use with a practical and stylish look.`;
    }

    if (
        lower.includes('earring') ||
        lower.includes('jewellery') ||
        lower.includes('jewelry') ||
        lower.includes('necklace') ||
        lower.includes('bracelet')
    ) {
        return `Elegant ${title} that adds a simple and stylish touch to your everyday look.`;
    }

    if (
        lower.includes('lamp') ||
        lower.includes('light')
    ) {
        return `Useful ${title} with a practical design for a cozy and convenient setup.`;
    }

    return `Useful ${title} with a stylish design, made for convenient everyday use.`;
}

function jsString(value) {
    return JSON.stringify(
        String(value ?? '')
            .replace(/\r?\n/g, ' ')
            .trim()
    );
}

// =========================================================
// AMAZON PRODUCT CODE — UNCHANGED STRUCTURE
// =========================================================

function buildProductCode({
    id,
    name,
    image,
    price,
    affiliateLink
}) {
    const description =
        makeProductDescription(
            name
        );

    const cleanPrice =
        String(
            price || ''
        ).trim() || '₹0';

    const imageUrls =
        String(image || '')
            .split(/\r?\n|,/)
            .map(x =>
                x.trim()
            )
            .filter(Boolean);

    const uniqueImages =
        [
            ...new Set(
                imageUrls
            )
        ];

    const imagesCode =
        uniqueImages.length
            ? uniqueImages
                  .map(
                      url =>
                          `        ${jsString(
                              url
                          )}`
                  )
                  .join(',\n')
            : `        ${jsString(
                  ''
              )}`;

    return `{
    id: ${jsString(id)},
    name: ${jsString(name)},
    images: [
${imagesCode}
    ],
    description: ${jsString(description)},
    price: ${jsString(cleanPrice)},
    affiliateLink: ${jsString(affiliateLink)}
},`;
}

// =========================================================
// Find next Amazon P ID
// =========================================================

function findNextShreeProductId(
    script
) {
    if (
        typeof script !==
            'string' ||
        !script.trim()
    ) {
        throw new Error(
            'script.js content is empty.'
        );
    }

    const affiliateStart =
        script.indexOf(
            'const affiliateProducts = ['
        );

    if (
        affiliateStart === -1
    ) {
        throw new Error(
            'affiliateProducts array not found in script.js'
        );
    }

    const afterStart =
        script.slice(
            affiliateStart
        );

    const closingMatch =
        afterStart.match(
            /\n\s*\];/
        );

    if (
        !closingMatch ||
        closingMatch.index ===
            undefined
    ) {
        throw new Error(
            'affiliateProducts closing ]; not found.'
        );
    }

    const affiliateEnd =
        affiliateStart +
        closingMatch.index;

    const affiliateBlock =
        script.slice(
            affiliateStart,
            affiliateEnd
        );

    const matches = [
        ...affiliateBlock.matchAll(
            /id\s*:\s*["']SHREE-P(\d+)["']/g
        )
    ];

    let highest = 0;

    for (
        const match of matches
    ) {
        const number =
            Number.parseInt(
                match[1],
                10
            );

        if (
            Number.isInteger(
                number
            ) &&
            number > highest
        ) {
            highest =
                number;
        }
    }

    return {
        id: `SHREE-P${String(
            highest + 1
        ).padStart(2, '0')}`,
        affiliateEnd
    };
}

// =========================================================
// Find next Meesho C ID
// =========================================================

function findNextMeeshoProductId(
    script
) {
    if (
        typeof script !==
            'string' ||
        !script.trim()
    ) {
        throw new Error(
            'script.js content is empty.'
        );
    }

    const matches = [
        ...script.matchAll(
            /id\s*:\s*["']SHREE-C(\d+)["']/g
        )
    ];

    let highest = 0;

    for (
        const match of matches
    ) {
        const number =
            Number.parseInt(
                match[1],
                10
            );

        if (
            Number.isInteger(
                number
            ) &&
            number > highest
        ) {
            highest =
                number;
        }
    }

    return `SHREE-C${String(
        highest + 1
    ).padStart(2, '0')}`;
}

// =========================================================
// Meesho product code builder
// =========================================================

function normalizeMeeshoForCode(
    data
) {
    const colors =
        Array.isArray(
            data.colors
        )
            ? data.colors
                  .map(color => {
                      if (
                          !color ||
                          !cleanText(
                              color.name
                          )
                      ) {
                          return null;
                      }

                      const images =
                          uniqueImages([
                              color.image,
                              ...(Array.isArray(
                                  color.images
                              )
                                  ? color.images
                                  : [])
                          ]);

                      const result = {
                          name:
                              cleanText(
                                  color.name
                              ),
                          image:
                              images[0] ||
                              '',
                          images
                      };

                      const colorPrice =
                          cleanPrice(
                              color.price
                          );

                      if (
                          colorPrice
                      ) {
                          result.price =
                              colorPrice;
                      }

                      if (
                          Array.isArray(
                              color.sizes
                          ) &&
                          color.sizes.length
                      ) {
                          result.sizes =
                              color.sizes
                                  .map(
                                      size =>
                                          normalizeSize(
                                              size,
                                              colorPrice
                                          )
                                  )
                                  .filter(
                                      Boolean
                                  );
                      }

                      return result;
                  })
                  .filter(Boolean)
            : [];

    const sizes =
        Array.isArray(
            data.sizes
        )
            ? data.sizes
                  .map(size =>
                      normalizeSize(
                          size,
                          data.price
                      )
                  )
                  .filter(Boolean)
            : [];

    return {
        name:
            cleanText(
                data.name
            ),
        images:
            uniqueImages(
                data.images || []
            ),
        shortDescription:
            cleanText(
                data.shortDescription ||
                    data.description ||
                    ''
            ),
        description:
            cleanText(
                data.description ||
                    data.shortDescription ||
                    ''
            ),
        price:
            cleanPrice(
                data.price
            ),
        colors,
        sizes
    };
}

function buildMeeshoProductCode({
    id,
    name,
    images,
    shortDescription,
    description,
    price,
    colors,
    sizes
}) {
    const product =
        normalizeMeeshoForCode({
            name,
            images,
            shortDescription,
            description,
            price,
            colors,
            sizes
        });

    const lines = [];

    lines.push('{');

    lines.push(
        `    id: ${jsString(id)},`
    );

    lines.push(
        `    name: ${jsString(
            product.name
        )},`
    );

    lines.push(
        '    images: ['
    );

    const generalImages =
        product.images.length
            ? product.images
            : [''];

    generalImages.forEach(
        (
            image,
            index
        ) => {
            lines.push(
                `        ${jsString(
                    image
                )}${
                    index <
                    generalImages.length -
                        1
                        ? ','
                        : ''
                }`
            );
        }
    );

    lines.push(
        '    ],'
    );

    lines.push(
        `    shortDescription: ${jsString(
            product.shortDescription
        )},`
    );

    lines.push(
        `    description: ${jsString(
            product.description
        )},`
    );

    lines.push(
        `    price: ${jsString(
            product.price ||
                '₹0'
        )},`
    );

    lines.push(
        '    colors: ['
    );

    product.colors.forEach(
        (
            color,
            colorIndex
        ) => {
            lines.push(
                '        {'
            );

            lines.push(
                `            name: ${jsString(
                    color.name
                )},`
            );

            lines.push(
                `            image: ${jsString(
                    color.image
                )},`
            );

            lines.push(
                '            images: ['
            );

            const colorImages =
                color.images.length
                    ? color.images
                    : [
                          color.image ||
                              ''
                      ];

            colorImages.forEach(
                (
                    image,
                    imageIndex
                ) => {
                    lines.push(
                        `                ${jsString(
                            image
                        )}${
                            imageIndex <
                            colorImages.length -
                                1
                                ? ','
                                : ''
                        }`
                    );
                }
            );

            lines.push(
                '            ],'
            );

            if (
                color.price
            ) {
                lines.push(
                    `            price: ${jsString(
                        color.price
                    )},`
                );
            }

            if (
                Array.isArray(
                    color.sizes
                ) &&
                color.sizes.length
            ) {
                lines.push(
                    '            sizes: ['
                );

                color.sizes.forEach(
                    (
                        size,
                        sizeIndex
                    ) => {
                        lines.push(
                            '                {'
                        );

                        lines.push(
                            `                    name: ${jsString(
                                size.name
                            )},`
                        );

                        if (
                            size.price
                        ) {
                            lines.push(
                                `                    price: ${jsString(
                                    size.price
                                )}`
                            );
                        } else {
                            lines.push(
                                `                    price: ${jsString(
                                    color.price ||
                                        product.price ||
                                        '₹0'
                                )}`
                            );
                        }

                        lines.push(
                            `                }${
                                sizeIndex <
                                color.sizes
                                    .length -
                                    1
                                    ? ','
                                    : ''
                            }`
                        );
                    }
                );

                lines.push(
                    '            ]'
                );
            } else {
                const last =
                    lines.pop();

                lines.push(
                    last.endsWith(
                        ','
                    )
                        ? last.slice(
                              0,
                              -1
                          )
                        : last
                );
            }

            lines.push(
                `        }${
                    colorIndex <
                    product.colors
                        .length -
                        1
                        ? ','
                        : ''
                }`
            );
        }
    );

    lines.push(
        '    ],'
    );

    lines.push(
        '    sizes: ['
    );

    product.sizes.forEach(
        (
            size,
            index
        ) => {
            lines.push(
                '        {'
            );

            lines.push(
                `            name: ${jsString(
                    size.name
                )},`
            );

            lines.push(
                `            price: ${jsString(
                    size.price ||
                        product.price ||
                        '₹0'
                )}`
            );

            lines.push(
                `        }${
                    index <
                    product.sizes.length -
                        1
                        ? ','
                        : ''
                }`
            );
        }
    );

    lines.push(
        '    ]'
    );

    lines.push(
        '},'
    );

    return lines.join(
        '\n'
    );
}

// =========================================================
// GitHub API helpers
// =========================================================

async function getGitHubFile() {
    if (!GITHUB_TOKEN) {
        throw new Error(
            'GITHUB_TOKEN is missing in Render environment variables.'
        );
    }

    const apiUrl =
        `https://api.github.com/repos/` +
        `${encodeURIComponent(
            GITHUB_OWNER
        )}/` +
        `${encodeURIComponent(
            GITHUB_REPO
        )}/` +
        `contents/${GITHUB_FILE_PATH}`;

    const response =
        await axios.get(
            apiUrl,
            {
                headers: {
                    Authorization:
                        `Bearer ${GITHUB_TOKEN}`,
                    Accept:
                        'application/vnd.github+json',
                    'X-GitHub-Api-Version':
                        '2022-11-28',
                    'User-Agent':
                        'Shree-Store-Extractor'
                },
                params: {
                    ref:
                        GITHUB_BRANCH
                },
                timeout: 20000
            }
        );

    if (
        !response.data ||
        !response.data.content
    ) {
        throw new Error(
            'GitHub returned an invalid script.js response.'
        );
    }

    return {
        apiUrl,
        sha:
            response.data.sha,
        content:
            Buffer.from(
                response.data.content,
                'base64'
            ).toString(
                'utf8'
            )
    };
}

async function getPublicGitHubScript() {
    const rawUrl =
        getPublicGitHubRawUrl();

    const response =
        await axios.get(
            rawUrl,
            {
                headers: {
                    'User-Agent':
                        'Shree-Store-Extractor',
                    Accept:
                        'text/plain'
                },
                timeout: 20000,
                responseType:
                    'text'
            }
        );

    if (
        typeof response.data !==
            'string' ||
        !response.data.trim()
    ) {
        throw new Error(
            'Unable to read public script.js from GitHub.'
        );
    }

    return response.data;
}

// =========================================================
// Amazon COPY — existing endpoint
// =========================================================

app.post(
    '/api/generate-product-code',
    async (req, res) => {
        try {
            const {
                name,
                price,
                image,
                affiliateLink
            } = req.body || {};

            if (
                !name ||
                !image ||
                !affiliateLink
            ) {
                return res.status(400).json({
                    success: false,
                    error:
                        'Name, image and affiliateLink are required.'
                });
            }

            const script =
                await getPublicGitHubScript();

            const {
                id
            } =
                findNextShreeProductId(
                    script
                );

            const code =
                buildProductCode({
                    id,
                    name,
                    image,
                    price,
                    affiliateLink
                });

            return res.json({
                success: true,
                productId: id,
                code
            });
        } catch (
            error
        ) {
            console.error(
                'Generate Product Code Error:',
                error.message
            );

            return res.status(500).json({
                success: false,
                error:
                    error.message ||
                    'Product code generation failed.'
            });
        }
    }
);

// =========================================================
// Meesho COPY
// =========================================================

app.post(
    '/api/generate-meesho-product-code',
    async (req, res) => {
        try {
            const script =
                await getPublicGitHubScript();

            const id =
                findNextMeeshoProductId(
                    script
                );

            const product =
                req.body || {};

            if (
                !product.name ||
                !Array.isArray(
                    product.images
                )
            ) {
                return res.status(400).json({
                    success: false,
                    error:
                        'Meesho product name and images are required.'
                });
            }

            const normalized =
                normalizeMeeshoForCode(
                    product
                );

            const code =
                buildMeeshoProductCode({
                    id,
                    ...normalized
                });

            return res.json({
                success: true,
                productId: id,
                code,
                product:
                    normalized
            });
        } catch (
            error
        ) {
            console.error(
                'Generate Meesho Product Code Error:',
                error.message
            );

            return res.status(500).json({
                success: false,
                error:
                    error.message ||
                    'Meesho product code generation failed.'
            });
        }
    }
);

// =========================================================
// Amazon DIRECT GITHUB UPDATE — existing structure
// =========================================================

app.post(
    '/api/add-product-to-github',
    async (req, res) => {
        try {
            const adminKey =
                req.headers[
                    'x-admin-key'
                ] || '';

            if (
                !ADMIN_KEY ||
                adminKey !==
                    ADMIN_KEY
            ) {
                return res.status(401).json({
                    success: false,
                    error:
                        'Invalid admin key.'
                });
            }

            const {
                name,
                price,
                image,
                affiliateLink
            } =
                req.body || {};

            if (
                !name ||
                !image ||
                !affiliateLink
            ) {
                return res.status(400).json({
                    success: false,
                    error:
                        'Name, image and affiliateLink are required.'
                });
            }

            const githubFile =
                await getGitHubFile();

            const {
                id,
                affiliateEnd
            } =
                findNextShreeProductId(
                    githubFile.content
                );

            const productCode =
                buildProductCode({
                    id,
                    name,
                    price,
                    image,
                    affiliateLink
                });

            const updatedContent =
                githubFile.content.slice(
                    0,
                    affiliateEnd
                ) +
                '\n' +
                productCode +
                githubFile.content.slice(
                    affiliateEnd
                );

            const encodedContent =
                Buffer.from(
                    updatedContent,
                    'utf8'
                ).toString(
                    'base64'
                );

            const updateResponse =
                await axios.put(
                    githubFile.apiUrl,
                    {
                        message:
                            `Add ${id} to affiliateProducts`,
                        content:
                            encodedContent,
                        sha:
                            githubFile.sha,
                        branch:
                            GITHUB_BRANCH
                    },
                    {
                        headers: {
                            Authorization:
                                `Bearer ${GITHUB_TOKEN}`,
                            Accept:
                                'application/vnd.github+json',
                            'X-GitHub-Api-Version':
                                '2022-11-28',
                            'User-Agent':
                                'Shree-Store-Extractor'
                        },
                        timeout:
                            20000
                    }
                );

            return res.json({
                success: true,
                productId: id,
                message:
                    `${id} successfully added to GitHub.`,
                commit:
                    updateResponse
                        .data
                        ?.commit
                        ?.sha ||
                    ''
            });
        } catch (
            error
        ) {
            console.error(
                'GitHub Update Error:',
                error.response
                    ?.data ||
                    error.message
            );

            return res.status(500).json({
                success: false,
                error:
                    error.response
                        ?.data
                        ?.message ||
                    error.message ||
                    'GitHub update failed.'
            });
        }
    }
);

// =========================================================
// Meesho DIRECT GITHUB UPDATE
// =========================================================

app.post(
    '/api/add-meesho-product-to-github',
    async (req, res) => {
        try {
            const adminKey =
                req.headers[
                    'x-admin-key'
                ] || '';

            if (
                !ADMIN_KEY ||
                adminKey !==
                    ADMIN_KEY
            ) {
                return res.status(401).json({
                    success: false,
                    error:
                        'Invalid admin key.'
                });
            }

            const product =
                req.body || {};

            if (
                !product.name ||
                !Array.isArray(
                    product.images
                )
            ) {
                return res.status(400).json({
                    success: false,
                    error:
                        'Meesho product name and images are required.'
                });
            }

            const githubFile =
                await getGitHubFile();

            const id =
                findNextMeeshoProductId(
                    githubFile.content
                );

            const normalized =
                normalizeMeeshoForCode(
                    product
                );

            const productCode =
                buildMeeshoProductCode({
                    id,
                    ...normalized
                });

            const marker =
                'const resellingProducts = [';

            const resellingStart =
                githubFile.content.indexOf(
                    marker
                );

            if (
                resellingStart === -1
            ) {
                throw new Error(
                    'resellingProducts array not found in script.js'
                );
            }

            const afterStart =
                githubFile.content.slice(
                    resellingStart
                );

            const closingMatch =
                afterStart.match(
                    /\n\s*\];/
                );

            if (
                !closingMatch ||
                closingMatch.index ===
                    undefined
            ) {
                throw new Error(
                    'resellingProducts closing ]; not found.'
                );
            }

            const resellingEnd =
                resellingStart +
                closingMatch.index;

            const updatedContent =
                githubFile.content.slice(
                    0,
                    resellingEnd
                ) +
                '\n' +
                productCode +
                githubFile.content.slice(
                    resellingEnd
                );

            const encodedContent =
                Buffer.from(
                    updatedContent,
                    'utf8'
                ).toString(
                    'base64'
                );

            const updateResponse =
                await axios.put(
                    githubFile.apiUrl,
                    {
                        message:
                            `Add ${id} to resellingProducts`,
                        content:
                            encodedContent,
                        sha:
                            githubFile.sha,
                        branch:
                            GITHUB_BRANCH
                    },
                    {
                        headers: {
                            Authorization:
                                `Bearer ${GITHUB_TOKEN}`,
                            Accept:
                                'application/vnd.github+json',
                            'X-GitHub-Api-Version':
                                '2022-11-28',
                            'User-Agent':
                                'Shree-Store-Extractor'
                        },
                        timeout:
                            20000
                    }
                );

            return res.json({
                success: true,
                productId: id,
                code:
                    productCode,
                message:
                    `${id} successfully added to GitHub.`,
                commit:
                    updateResponse
                        .data
                        ?.commit
                        ?.sha ||
                    ''
            });
        } catch (
            error
        ) {
            console.error(
                'Meesho GitHub Update Error:',
                error.response
                    ?.data ||
                    error.message
            );

            return res.status(500).json({
                success: false,
                error:
                    error.response
                        ?.data
                        ?.message ||
                    error.message ||
                    'Meesho GitHub update failed.'
            });
        }
    }
);

// =========================================================
// Start server
// =========================================================

app.listen(
    PORT,
    () => {
        console.log(
            `🚀 Server running on http://localhost:${PORT}`
        );

        console.log(
            `📦 Admin Panel: http://localhost:${PORT}/admin.html`
        );
    }
);
