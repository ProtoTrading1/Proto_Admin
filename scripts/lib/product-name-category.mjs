import { inferArtSupplyPath, isArtSupplyProduct } from './art-supplies-paths.mjs';
import { inferWritingCorrectionPath, isWritingCorrectionProduct } from './writing-correction-paths.mjs';
import { inferWoodBeadPath, isWoodBeadName } from './wood-bead-paths.mjs';

export function inferSemiPreciousPath(productName, sku = '') {
  const n = String(productName || '').toUpperCase();
  const s = String(sku || '').toUpperCase();
  let mm = null;
  const skuMatch = s.match(/^SP-(\d{1,2})-/);
  if (skuMatch) mm = skuMatch[1];
  if (!mm) {
    const nameMatch = n.match(/\b(\d{1,2})\s*MM\b/);
    if (nameMatch) mm = nameMatch[1];
  }
  if (mm) return `Beads > Semi-Precious > SIZE: ${mm}mm`;
  if (/SEMI[\s-]*PRECIOUS/.test(n)) return 'Beads > Semi-Precious';
  return null;
}

export function isSemiPreciousProduct(productName, sku = '') {
  const n = String(productName || '').toUpperCase();
  const s = String(sku || '').toUpperCase();
  return /SEMI[\s-]*PRECIOUS/.test(n) || /^SP-\d+-/.test(s);
}

function inferGlassPearlPath(productName) {
  const n = String(productName || '').toUpperCase();
  const m = n.match(/GLASS\s*PEARL\s*(\d+)\s*MM/);
  if (m) return `Beads > Glass & Crystal > Pearls > SIZE: ${m[1]}mm`;
  if (/GLASS\s*PEARL/.test(n)) return 'Beads > Glass & Crystal > Pearls';
  return null;
}

function inferFashionBagPath(productName) {
  const n = String(productName || '').toUpperCase();
  if (/BAG\s*STRAP/.test(n)) return 'Fashion & Accessories > Leather > Bag Straps';
  if (/LEATHER\s+SLING|LEATHER\s+BAG|LEATHER\s+HANDBAG/.test(n)) {
    return 'Fashion & Accessories > Leather > Ladies Sling & Crossbody';
  }
  if (/CLUTCH|WRISTLET/.test(n)) return 'Fashion & Accessories > Synthetic Bags > Wristlets & Clutches';
  if (/COIN\s*PURSE|SMALL\s*ACCESSOR/.test(n)) {
    return 'Fashion & Accessories > Synthetic Bags > Small Accessories';
  }
  if (/BACKPACK|SHOULDER\s*BAG/.test(n)) return 'Fashion & Accessories > Synthetic Bags > Backpack & Shoulder';
  if (/TOTE/.test(n)) return 'Fashion & Accessories > Synthetic Bags > Tote';
  if (/SHOPPER/.test(n)) return 'Fashion & Accessories > Synthetic Bags > Shopper';
  if (/SLING\s*BAG|CROSSBODY/.test(n)) return 'Fashion & Accessories > Synthetic Bags > Sling & Crossbody';
  if (/LADIES\s*BAG|HANDBAG|BOUTIQUE\s*BAG|\bBAG\b/.test(n)) {
    return 'Fashion & Accessories > Synthetic Bags > Handbags';
  }
  return null;
}

function inferPlasticBeadPath(productName) {
  const n = String(productName || '').toUpperCase();
  const m = n.match(/(?:PLASTIC\s*LUSTRE|PLASTIC)\s*ROUND\s*(\d+)\s*MM/);
  if (m) return `Beads > Plastic & Crystal > SIZE: ${m[1]}mm`;
  if (/PLASTIC\s*LUSTRE|PLASTIC\s*&\s*CRYSTAL/i.test(n)) return 'Beads > Plastic & Crystal';
  return null;
}

function inferBeautyPath(productName) {
  const n = String(productName || '').toUpperCase();
  if (/PERFUME|FRAGRANCE|COLOGNE|IMAN\b|KISMET|RAEESAH|AL\s*CAPONE|DEEP\s*OCEAN/i.test(n)) {
    return 'Beauty & Personal Care > Fragrances > Inspired Perfumes';
  }
  if (/ANTI[\s-]*PERSPIRANT|DEODORANT|MIJONA/i.test(n)) {
    return 'Beauty & Personal Care > Fragrances > Anti-perspirant';
  }
  if (/BODY\s*MIST/i.test(n)) return 'Beauty & Personal Care > Fragrances > Body Mist';
  if (/HAND\s*WASH|HAND\s*SANITISER|DISINFECTANT/i.test(n)) {
    return 'Beauty & Personal Care > Skin Care > Hand Wash and Soaps';
  }
  if (/BODY\s*SCRUB|FOOT\s*SCRUB|EXFOLIAT/i.test(n)) {
    return 'Beauty & Personal Care > Skin Care > Scrubs & Butters';
  }
  if (/BODY\s*CREAM|BODY\s*LOTION|BODY\s*BUTTER|HAND\s*CREAM|CREAMS?|LOTION|OLAY|DOVE|PEPPER\s*TREE|BODYLAB/i.test(n)) {
    return 'Beauty & Personal Care > Skin Care > Creams and Lotions';
  }
  if (/FACE\s*WASH|SHOWER\s*GEL|BATH\s*(?:AND|&)\s*SHOWER/i.test(n)) {
    return 'Beauty & Personal Care > Skin Care > Face and Body Wash';
  }
  if (/SHAMPOO|CONDITIONER/i.test(n)) {
    return 'Beauty & Personal Care > Hair Care > Shampoo & Conditioners';
  }
  if (/COSMETIC|LIPSTICK|MASCARA|EYES|EYEBROW|NAIL/i.test(n)) {
    return 'Beauty & Personal Care > Cosmetics > Face & Cheeks';
  }
  if (/SOAP|SCENTED\s*SOAP/i.test(n)) {
    return 'Homeware > Bathroom > Soaps & Hand Wash';
  }
  return null;
}

function inferHomewarePath(productName) {
  const n = String(productName || '').toUpperCase();
  if (/CANDLE|TEALIGHT|REED\s*DIFFUSER/i.test(n)) {
    return 'Homeware > Scents and Aroma > Candles & Diffusers';
  }
  if (/CAKE\s*STAND/i.test(n)) return 'Homeware > Baking > Cake Stands';
  if (/GLASS\s*JAR/i.test(n)) return 'Homeware > Kitchen > Glass Jars';
  if (/MUG|CERAMIC/i.test(n)) return 'Homeware > Kitchen > Utensils';
  if (/BLANKET/i.test(n)) return 'Homeware > Bedroom > Blankets';
  if (/BAKING\s*SET|BAKING/i.test(n)) return 'Homeware > Baking > Silicone Moulds';
  if (/BAMBOO|SPOON|UTENSIL/i.test(n)) return 'Homeware > Kitchen > Utensils';
  if (/ENAMEL/i.test(n)) return 'Homeware > Kitchen > Enamel';
  if (/AERATOR/i.test(n)) return 'Hardware > Garden > Garden Tools';
  return null;
}

/** Best-effort category path from product title and optional ERP description. */
export function inferCategoryPathFromName(productName, sku = '', erpDescription = '') {
  const n = String(productName || '').toUpperCase();
  const erp = String(erpDescription || '').toUpperCase();
  const text = `${n} ${erp}`.trim();

  if (isWoodBeadName(text)) return inferWoodBeadPath(text);
  if (isSemiPreciousProduct(text, sku)) return inferSemiPreciousPath(text, sku);
  if (isArtSupplyProduct(text)) return inferArtSupplyPath(text);
  if (isWritingCorrectionProduct(text)) return inferWritingCorrectionPath(text);

  const pearl = inferGlassPearlPath(text);
  if (pearl) return pearl;

  const plastic = inferPlasticBeadPath(text);
  if (plastic) return plastic;

  const plasticPearl = text.match(/PLASTIC\s*PEARLS?\s*-\s*(\d+)\s*MM/i);
  if (plasticPearl) return `Beads > Glass & Crystal > Pearls > SIZE: ${plasticPearl[1]}mm`;
  if (/PLASTIC\s*PEARLS?|PLASTIC\s*CROW\s*BEAD/i.test(text)) return 'Beads > Glass & Crystal > Pearls';

  if (/SYNTHETIC\s*AGED\s*STONE|\bHEART\b.*\d+\s*MM/i.test(text)) return 'Beads > Semi-Precious';
  if (/ZULU\s*BEAD/i.test(text)) return 'Beads > Natural > Zulu';
  if (/NECKLACE\s*-/i.test(text)) return 'Jewellery > Jewellery > Necklaces';

  if (/SHIFTER|CHISEL|SCREWDRIVER|UTILITY\s*KNIFE|SPANNER|FORGED\s*STEEL/i.test(text)) {
    return 'Hardware > Tools > Screwdrivers';
  }
  if (/BATHROOM\s*ACCESSOR/i.test(text)) return 'Homeware > Bathroom > Bodywash';
  if (/RED\s*WOOD\s*STYLE|DISPLAY/i.test(text)) {
    return 'Jewellery > Jewellery > Jewellery Display Stands';
  }

  const beauty = inferBeautyPath(text);
  if (beauty) return beauty;

  const homeware = inferHomewarePath(text);
  if (homeware) return homeware;

  if (/PENCIL\s*CASE/i.test(text)) return 'Stationery > School & Office > Pencil Bags & Cases';
  if (/CLIPBOARD/i.test(text)) return 'Stationery > School & Office > Clipboards';
  if (/COLOURING\s*BOOK|FLASHCARD|MOTARRO\s*FLASH/i.test(text)) return 'Stationery > School & Office > Books & Notebooks';
  if (/LAMINAT/i.test(text)) return 'Stationery > School & Office > Accessories';
  if (/BLACKBOARD\s*PAINT/i.test(text)) return 'Arts and Crafts > Art Supplies > Paints > Acrylic';
  if (/MOTARRO|MARLIN|SCHNEIDER|STAPLER|SCISSOR|SHARPENER|WHITEBOARD|CUTTING\s*MAT|STAMP|LABEL|GLUE|TAPE|ID\s*CARD|CREPE\s*PAPER/i.test(text)) {
    return 'Stationery > School & Office > Accessories';
  }
  if (/ROOM\s*SPRAY|AIR\s*FRESH/i.test(text)) {
    return 'Homeware > Scents and Aroma > Candles & Diffusers';
  }
  if (/PLACE\s*MAT/i.test(text)) return 'Homeware > Kitchen > Placemats';
  if (/SCISSOR|BOTTLE\s*OPENER|KITCHEN/i.test(text)) return 'Homeware > Kitchen > Utensils';
  if (/NOUGART|NOUGAT/i.test(text)) return 'Confectionery > Sweets & Hard Candies';
  if (/PUZZLE|SOCCER\s*BALL|SAND\s*BUCKET|ROLY\s*POLY|GLIDER/i.test(text)) {
    return 'Kids Toys & Games > Kids Toys';
  }

  if (/RIBBON|GROSGRAIN|PETERSHAM|ORGANZA|SATIN RIBBON|JUTE RIBBON/i.test(text)) {
    return 'Textiles > Ribbon';
  }
  if (/\bYARN\b|\bWOOL\b/i.test(text)) return 'Textiles > Yarn > Wool';
  if (/CHITENGE|DRESS\s*MATERIAL|FABRIC/i.test(text)) return 'Textiles > Ribbon & Trim';
  if (/IRON\s*ON\s*PATCH/.test(text)) return 'Fashion & Accessories > Iron-On Patch';

  const bag = inferFashionBagPath(text);
  if (bag) return bag;

  if (/WALLET/i.test(text)) return 'Fashion & Accessories > Leather > Wallets & Purses';
  if (/FEDORA|SUNHAT|PANAMA|\bHAT\b|\bCAP\b/.test(text)) {
    return 'Fashion & Accessories > Hats & Caps > Fedora';
  }
  if (/SCARF/i.test(text)) return 'Fashion & Accessories > Scarves';
  if (/PROTECTIVE\s*MASK|DISPOSABLE\s*MASK/i.test(text)) {
    return 'Arts and Crafts > Crafts > Masks';
  }

  if (/EXERCISE BOOK|COUNTER BOOK|MANUSCRIPT BOOK|MEMO BOOK|EXAM PAD|SKETCH PAD|NOTEBOOK|DIARY|PLANNER/i.test(text)) {
    return 'Stationery > School & Office > Books & Notebooks';
  }
  if (/ENVELOPE/i.test(text)) return 'Stationery > School & Office > Accessories';
  if (/ERASER/i.test(text)) return 'Stationery > School & Office > Writing & Correction > Correction and Erasing';

  if (/CLAY|PLASTICINE|PLAYDOUGH|CRAZY\s*CRAFTY/i.test(text)) {
    return 'Arts and Crafts > Art Supplies > Sculpting & Moulding > Clay';
  }
  if (/STICKER/i.test(text)) return 'Arts and Crafts > Crafts > Stickers';
  if (/EMBROIDERY/i.test(text)) return 'Arts and Crafts > Crafts > Embroidery';
  if (/WOOD\s*CROSS|STAR\s*WOOD|HEART\s*WOOD|DOUNUT\s*WOOD|DISC\s*HANGING|HEART\s*HANGING|WOOD\s*VARNISH/i.test(text)) {
    return 'Arts and Crafts > Crafts > Wooden';
  }

  if (/BANGLE|BRACELET\s*STAND|NECKLACE\s*STAND|ECKLACE\s*STAND|RACELET\s*STAND/i.test(text)) {
    return 'Jewellery > Jewellery > Jewellery Display Stands';
  }
  if (/INDIAN\s*BANGLE/i.test(text)) return 'Jewellery > Jewellery > Bracelets';

  if (/NECKLACE\s*CHAIN|\bCHAIN\b.*NECKLACE/.test(text)) {
    return 'Jewellery > Findings > Stringing Materials > Chain';
  }
  if (/SUEDE\s*CORD|IMITATION\s*SUEDE|\bCORD\b/.test(text)) {
    return 'Jewellery > Findings > Stringing Materials > Cord';
  }
  if (/NYLON\s*THREAD|BONDED\s*NYLON|\bTHREAD\b/.test(text)) {
    return 'Jewellery > Findings > Stringing Materials > Threads';
  }
  if (/WIRE\b|MEMORY\s*WIRE/.test(text)) return 'Jewellery > Findings > Stringing Materials > Wire';
  if (/ELASTIC\b/.test(text)) return 'Jewellery > Findings > Stringing Materials > Elastic';

  if (/FINDINGS?|CLASP|CRIMP|JUMPRING|EARRING\s*HOOK|EYEPIN|HEADPIN|CALOTTE/i.test(text)) {
    return 'Jewellery > Findings';
  }
  if (/DISPLAY\s*STAND|JEWELLERY\s*TOOL|PLIER/i.test(text)) {
    return 'Jewellery > Jewellery Tools and Equipment';
  }

  if (/LAVA\s*BEAD/i.test(text)) return 'Beads > Natural > Seed';
  if (/(?:AGATE|AVENTURINE|OBSIDIAN|QUARTZ|CARNELIAN|JASPER|TIGER|EYE|CHIP|STONE)\b/.test(text)) {
    const mm = text.match(/\b(\d{1,2})\s*MM\b/);
    if (mm) return `Beads > Semi-Precious > SIZE: ${mm[1]}mm`;
    return 'Beads > Semi-Precious';
  }
  if (/GLASS\s*OPAQUE|GLASS\s*CRACKLE/i.test(text)) return 'Beads > Glass & Crystal';
  if (/GLASS\s*CRYSTAL|ACRYLIC\s*(?:ARROW|BALOON|PEAR|TEAR|DROP|DIAMOND)|RONDELLE|MURANO|CZECH|GLASS\s*FOIL/i.test(text)) {
    return 'Beads > Glass & Crystal';
  }
  if (/GLASS\s*BEAD/i.test(text)) return 'Beads > Glass & Crystal';
  if (/EARTH\s*STONE/i.test(text)) return 'Beads > Semi-Precious';
  if (/SEED\s*BEAD/i.test(text)) return 'Beads > Glass & Crystal > Seed Beads';
  if (/WOOD\s*RAW/i.test(text)) return 'Beads > Wood > Raw Wood';
  if (/METAL|ALUMINIUM|CONE|BRASS|NICKEL/i.test(text)) return 'Beads > Beads By Material > Beads';

  if (/ZIPLOCK/i.test(text)) return 'Packaging & Storage > Packaging Packets and Bags > Ziplock';
  if (/PVC\s*PLASTIC|RESEALABLE\s*PACKET/i.test(text)) {
    return 'Packaging & Storage > Packaging Packets and Bags > Resealable PVC';
  }
  if (/DISPLAY\s*TAG/i.test(text)) return 'Packaging & Storage > Tags > Jewellery';

  if (/\bD-RING\b|\bD\s*RING\b/i.test(text)) return 'Bag & Belt Components > Square and D-Rings';
  if (/\bSLIDER\b/i.test(text)) return 'Bag & Belt Components > Sliders';
  if (/\bBUCKLE\b/i.test(text)) return 'Bag & Belt Components > Buckles';

  if (/BONBON|SWEET|CANDY|GELO|JELLY\s*BEAR|LICORICE|NOUGART|NOUGAT|CHOCOLATE|LINDT|CRACKER|PICKO/i.test(text)) {
    return 'Confectionery > Sweets & Hard Candies';
  }
  if (/COFFEE|ESPRESSO/i.test(text)) return 'Confectionery > Coffee Pods';

  if (/STATIONERY:\s*PEN|\bPENS\b|BALL\s*POINT/i.test(text)) {
    return 'Stationery > School & Office > Writing & Correction > Pens and Pencils';
  }
  if (/RULER/i.test(text)) return 'Stationery > School & Office > Measuring & Viewing';
  if (/HAND\s*SANITI|TISSUE\s*OIL|SAFEGUARD/i.test(text)) {
    return 'Beauty & Personal Care > Skin Care > Hand Wash and Soaps';
  }
  if (/WATER\s*SAVER|REGULATOR/i.test(text)) return 'Hardware > Garden > Garden Tools';
  if (/TURNER|NYLON\s*TURNER/i.test(text)) return 'Homeware > Kitchen > Utensils';
  if (/SMART\s*WATCH|WATCH\b/i.test(text)) return 'Electronics & Accessories > Clocks & Watches > Watches';
  if (/POSITIVE\s*BLADE|AUTO\s*LOCK/i.test(text)) return 'Hardware > Tools > Screwdrivers';
  if (/USB|FLASH\s*DRIVE|SD\s*CARD|MICRO\s*SD|MULTIPLUG|ADAPTOR|EXTENSION\s*LEAD/i.test(text)) {
    return 'Electronics & Accessories > Media Storage';
  }
  if (/HIKVISION|CAMERA|HEADPHONE|EARPHONE|JVC|BLUETOOTH|WIRELESS/i.test(text)) {
    return 'Electronics & Accessories > Earphones & Headphones';
  }
  if (/LED\s|TORCH|HEADLAMP|WORK\s*LIGHT/i.test(text)) {
    return 'Electronics & Accessories > Batteries > Other';
  }
  if (/LIGHT\s*BULB|RECHARGABLE|BATTERY/i.test(text)) {
    return 'Electronics & Accessories > Batteries > Other';
  }

  if (/MACBOOK\s*COVER|LEATHER\s*ID/i.test(text)) {
    return 'Fashion & Accessories > Synthetic Bags > MacBook Cover';
  }
  if (/BEANIE|WOOLEN/i.test(text)) return 'Fashion & Accessories > Hats & Caps > Fedora';
  if (/BONDPAPER|TYPEK/i.test(text)) return 'Stationery > School & Office > Books & Notebooks';
  if (/LATEX\s*GLOVE|SANITISER\s*SPRAY/i.test(text)) {
    return 'Beauty & Personal Care > Skin Care > Hand Wash and Soaps';
  }
  if (/JEWELLERY\s*CLEANING|VELVET\s*POUCH/i.test(text)) {
    return 'Packaging & Storage > Display > Jewellery';
  }
  if (/PARTY\s*HALO|BALLOON/i.test(text)) return 'Party, Events & Seasonals > Party Décor';
  if (/WINDMILL/i.test(text)) return 'Hardware > Garden > Garden Tools';
  if (/COMPUTING\s*FRAME|WOODEN\s*BLOCKS|WOODEN\s*MULTI/i.test(text)) {
    return 'Kids Toys & Games > Kids Toys';
  }

  if (/PARASOL|PAPER\s*PARASOL/i.test(text)) return 'Party, Events & Seasonals > Parasols';
  if (/SOFT\s*TOY|DOLL/i.test(text)) return 'Kids Toys & Games > Soft Toys';
  if (/CHESS|DOMINO|CHARADES|GROWING\s*FOAM|BEAUTY\s*PLAY|ANIMAL\s*TRUCK|BASKET\s*BALL|UNO|PLAYING\s*CARDS|HUNGRY\s*HIPPOS|TIC[\s-]*TAC|MIKADO|PICTIONARY|CARD\s*GAME/i.test(text)) {
    return 'Kids Toys & Games > Games';
  }
  if (/FIDGET|KIDS\s*TOY|\bTOY\b/i.test(text)) return 'Kids Toys & Games > Kids Toys';

  if (/\bCHAIN\b/i.test(text)) return 'Jewellery > Findings > Stringing Materials > Chain';
  if (/\bPURSE\b/i.test(text)) return 'Fashion & Accessories > Synthetic Bags > Wristlets & Clutches';

  if (/\bBEAD\b|\bHEART\b|\bDISC\b/i.test(text)) return 'Beads > Glass & Crystal';

  return null;
}

export function categoryFieldsFromLiveRow(row) {
  if (!row?.category) return null;
  return {
    category: row.category,
    subcategory_one: row.subcategory_one || row.category,
    subcategory_two: row.subcategory_two || null,
    subcategory_three: row.subcategory_three || null,
    subcategory_four: row.subcategory_four || null,
  };
}
