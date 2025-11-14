# ROOT CAUSE ANALYSIS: Issue #39947 - NULL Values in Locale::formatPrice()

**Datum analýzy:** 2025-11-07
**Issue:** https://github.com/PrestaShop/PrestaShop/issues/39947

---

## EXECUTIVE SUMMARY

Fatal TypeError v `Locale::formatPrice()` je **symptomem hlubšího problému** s nedostatečnou validací NULL hodnot napříč celým price calculation flow. Problém se netýká pouze Locale třídy, ale celého řetězce zpracování cen.

**Implementovaný fix** (přidání `|null` do type hints) řeší immediate crash, ale **existují další místa**, kde by měla být lepší validace.

---

## CHAIN OF EVENTS - KDY DOCHÁZÍ K PROBLÉMU

### Scénář podle issue reportu:

1. **Vícenásobná prostředí**: Uživatel pracuje s PrestaShop na více strojích
2. **Import/Delete operace**: Produkty jsou smazány nebo importovány na jednom stroji
3. **Cached session data**: Druhý stroj má stále cached košík s odkazy na tyto produkty
4. **Navigace na cart/product pages**: User přistoupí na stránku s nevalidními produkty
5. **NULL ceny**: getPriceStatic() vrací NULL místo ceny
6. **CRASH**: formatPrice() dostane NULL → TypeError

---

## ROOT CAUSE #1: Product::getPriceStatic() může vrátit NULL

**Soubor:** `classes/Product.php`
**Return type:** `float|null` (řádek 3349)

### Situace, kdy vrací NULL:

#### **Místo 1: Chybějící produkt/kombinace v cache** (řádek 3618-3619)
```php
if (!isset(self::$_pricesLevel2[$cache_id_2][(int) $id_product_attribute])) {
    return null;  // ❌ Produkt nebo kombinace nenalezena
}
```

**K tomu dochází když:**
- Produkt byl smazán, ale košík ho stále obsahuje
- Kombinace produktu neexistuje
- Cache nekonzistence mezi servery
- Race condition při multi-server setup

#### **Místo 2: Chybějící order detail** (řádek 3816-3817)
```php
if (!is_array($res) || empty($res)) {
    return null;  // ❌ Order detail nenalezen
}
```

**K tomu dochází když:**
- Objednávka byla smazána
- Order detail missing nebo corrupted
- Database inconsistency

---

## ROOT CAUSE #2: NULL hodnoty nejsou validovány před použitím

### **Problém A: Cart::getSummaryDetails()** - Žádná NULL kontrola

**Soubor:** `classes/Cart.php:4136-4148`

```php
foreach ($products as $key => &$product) {
    // getPriceStatic() může vrátit NULL!
    $product['price_without_quantity_discount'] = Product::getPriceStatic(
        $product['id_product'],
        !Product::getTaxCalculationMethod(),
        $product['id_product_attribute'],
        6,
        null,
        false,
        false
    );  // ❌ Žádná kontrola NULL

    if ($product['reduction_type'] == 'amount') {
        // $product['price_wt'] nebo $product['price'] také může být NULL!
        $reduction = (!Product::getTaxCalculationMethod() ? (float) $product['price_wt'] : (float) $product['price'])
                     - (float) $product['price_without_quantity_discount'];

        // Zde se volá formatPrice() s potenciálně NULL reduction!
        $product['reduction_formatted'] = Tools::getContextLocale($context)->formatPrice(
            $reduction,  // ❌ Může obsahovat NULL
            $context->currency->iso_code
        );
    }
}
```

**Dopad:**
- NULL z getPriceStatic() se přímo použije v aritmetice
- Výsledek může být NULL nebo NaN
- formatPrice() dostane invalid hodnotu → crash

---

### **Problém B: Product::getProductProperties()** - Přímé přiřazení bez kontroly

**Soubor:** `classes/Product.php:5427-5439`

```php
// getPriceStatic() může vrátit NULL
$row['price_tax_exc'] = $priceTaxExcluded = Product::getPriceStatic(
    (int) $row['id_product'],
    false,
    $id_product_attribute,
    self::$_taxCalculationMethod == PS_TAX_EXC ? Context::getContext()->getComputingPrecision() : 6,
    null,
    false,
    true,
    $quantityToUseForPriceCalculations
);  // ❌ Žádná kontrola NULL

if (self::$_taxCalculationMethod == PS_TAX_EXC) {
    // Tools::ps_round() s NULL hodnotou!
    $row['price_tax_exc'] = Tools::ps_round($priceTaxExcluded, Context::getContext()->getComputingPrecision());
    $row['price'] = $row['price_tax_exc'];
} else {
    $row['price'] = Tools::ps_round($priceTaxExcluded, Context::getContext()->getComputingPrecision());
}

// Později v kódu (řádky 5440+):
$row['price_tax_inc'] = $priceTaxIncluded = Product::getPriceStatic(
    (int) $row['id_product'],
    true,
    ...
);  // ❌ Opět bez kontroly NULL
```

**Dopad:**
- NULL hodnoty se propagují do $row array
- Používají se v product presenters
- Nakonec se volá formatPrice() → crash

---

### **Problém C: PriceFormatter::format()** - Očekává float, může dostat NULL

**Soubor:** `src/Adapter/Product/PriceFormatter.php:55-62`

```php
/**
 * @param float $price  // ❌ Type hint říká float, ale může přijít NULL!
 * @param int|Currency|array|null $currency
 *
 * @return string
 */
public function format($price, $currency = null)
{
    $context = Context::getContext();
    $priceCurrency = is_array($currency) ? $currency['iso_code'] : null;
    $priceCurrency = !$priceCurrency && $currency instanceof Currency ? $currency->iso_code : $priceCurrency;
    $priceCurrency = !$priceCurrency ? $context->currency->iso_code : $priceCurrency;

    return Tools::getContextLocale($context)->formatPrice($price, $priceCurrency);
    // ❌ $price může být NULL a jde přímo do formatPrice()
}
```

**Dopad:**
- Type hint deklaruje `float`, ale caller může předat NULL (z getPriceStatic())
- PHP 8.4 strict types vyhodí TypeError pokud Locale::formatPrice() neakceptuje NULL

---

## FLOW DIAGRAM - Jak se NULL propaguje

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. USER ACTION                                                  │
│    - Naviguje na košík/produkt s deleted/missing item          │
└────────────────────┬────────────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. Product::getPriceStatic()                                    │
│    - Hledá produkt v cache/DB                                   │
│    - Produkt nenalezen                                          │
│    ➜ return null;  ❌                                           │
└────────────────────┬────────────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. Cart::getSummaryDetails() nebo Product::getProductProperties│
│    - Přiřadí NULL do $product['price']                         │
│    - Žádná validace, NULL se propaguje dál                      │
└────────────────────┬────────────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. PriceFormatter::format($price)                               │
│    - $price je NULL (type hint říká float!)                    │
│    - Předává dál do formatPrice()                               │
└────────────────────┬────────────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. Locale::formatPrice(null, 'EUR')  [PŘED FIXEM]             │
│    - Type hint: int|float|string (ne null!)                    │
│    - PHP 8.4 vyhodí TypeError                                   │
│    ➜ CRASH ❌                                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## IMPLEMENTOVANÝ FIX - CO ŘEŠÍ A CO NE

### ✅ CO FIX ŘEŠÍ:

**Soubory:**
- `src/Core/Localization/Locale.php`
- `src/Core/Localization/LocaleInterface.php`

**Změny:**
```php
// PŘED:
public function formatPrice(int|float|string $number, string $currencyCode): string

// PO:
public function formatPrice(int|float|string|null $number, string $currencyCode): string
{
    return $this->numberFormatter->format(
        $number ?? 0,  // ← NULL se převede na 0
        $this->getPriceSpecification($currencyCode)
    );
}
```

**Výhody:**
1. ✅ **Eliminuje TypeError** - aplikace nekrachne
2. ✅ **Graceful degradation** - NULL → 0
3. ✅ **Backward compatible** - existující kód funguje
4. ✅ **Quick fix** - řeší immediate problem

### ❌ CO FIX NEŘEŠÍ:

1. **Root cause zůstává** - stále se vytvářejí NULL ceny
2. **Skrývá větší problém** - uživatel vidí $0.00 místo erroru
3. **Data integrity** - smazané produkty v košíku nejsou ošetřeny
4. **Cache inconsistency** - multi-server setup může mít stale data
5. **Business logika** - produkt s NULL cenou by neměl být displayován

---

## DOPORUČENÁ DODATEČNÁ ŘEŠENÍ

### 🔴 PRIORITY 0 - OKAMŽITÉ (hotovo v tomto fixu)

✅ **Fix Locale::formatPrice()** - Přidán NULL handling
✅ **Fix Locale::formatNumber()** - Přidán NULL handling

### 🟠 PRIORITY 1 - VYSOKÁ (mělo by být implementováno)

#### **1. Validace v Cart::getSummaryDetails()**

```php
foreach ($products as $key => &$product) {
    $product['price_without_quantity_discount'] = Product::getPriceStatic(...);

    // PŘIDAT:
    if ($product['price_without_quantity_discount'] === null) {
        // Log warning
        PrestaShopLogger::addLog(
            'Product price is NULL: ' . $product['id_product'],
            3, // Warning
            null,
            'Product',
            $product['id_product']
        );

        // Skip nebo použij fallback
        $product['price_without_quantity_discount'] = 0;
        continue; // nebo continue foreach
    }
}
```

#### **2. Validace v Product::getProductProperties()**

```php
$priceTaxExcluded = Product::getPriceStatic(...);

// PŘIDAT:
if ($priceTaxExcluded === null) {
    PrestaShopLogger::addLog(
        'Unable to get price for product: ' . $row['id_product'],
        3,
        null,
        'Product',
        $row['id_product']
    );
    return false; // Nebo default fallback hodnota
}

$row['price_tax_exc'] = $priceTaxExcluded;
```

#### **3. Type hint fix v PriceFormatter**

```php
/**
 * @param float|null $price  // ← OPRAVIT type hint!
 * @param int|Currency|array|null $currency
 *
 * @return string
 */
public function format($price, $currency = null)
{
    // PŘIDAT:
    if ($price === null) {
        $price = 0;
    }

    $context = Context::getContext();
    // ... rest of code
}
```

### 🟡 PRIORITY 2 - STŘEDNÍ (pro long-term stability)

#### **4. Cart cleanup při product delete**

Implementovat hook `actionProductDelete` který:
- Vyčistí produkty ze všech košíků
- Invaliduje relevantní cache
- Notifikuje uživatele o změnách v košíku

#### **5. Robust cache invalidation**

Při multi-server setup:
- Použít Redis/Memcached pro sdílenou cache
- Implementovat proper cache invalidation
- Monitoring cache consistency

#### **6. Product availability check**

Před renderem cart/product pages:
- Validovat že produkty stále existují
- Automaticky odstranit nevalidní items
- Ukázat user-friendly zprávu

---

## MONITORING & ALERTING

### Doporučené metriky:

```php
// Přidat do Product::getPriceStatic()
if (!isset(self::$_pricesLevel2[$cache_id_2][(int) $id_product_attribute])) {
    // Log tento event!
    if (defined('_PS_METRICS_ENABLED_') && _PS_METRICS_ENABLED_) {
        Metrics::increment('product.price.null_returned', [
            'product_id' => $id_product,
            'attribute_id' => $id_product_attribute,
        ]);
    }

    return null;
}
```

**Sledovat:**
- Frekvence NULL returns z getPriceStatic()
- Které produkty nejčastěji způsobují NULL
- Časové vzory (po importech/deletes?)

---

## ZÁVĚR

### Současný stav po fixu:

✅ **Immediate problem solved** - TypeError eliminován
⚠️ **Root cause remains** - NULL ceny se stále generují
⚠️ **User experience** - Vidí $0.00 místo správné ceny nebo chyby

### Doporučený action plan:

1. ✅ **HOTOVÉ:** Locale NULL handling (tento fix)
2. **DALŠÍ KROK:** Implementovat validaci v Cart a Product třídy (Priority 1)
3. **LONG-TERM:** Cart cleanup hooks a cache strategy (Priority 2)
4. **MONITORING:** Trackovat NULL price events

### Estimated effort:

- Priority 0 (hotovo): ✅ 1 den
- Priority 1: 3-5 dní
- Priority 2: 1-2 týdny

---

**Připravil:** Claude (Anthropic)
**Datum:** 2025-11-07
