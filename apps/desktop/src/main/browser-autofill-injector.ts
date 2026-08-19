/**
 * In-page Autofill scripts and form detection engine for Kestrel Browser.
 */

export function generateFormDetectionScript(): string {
	return `(() => {
    try {
      const inputs = Array.from(document.querySelectorAll("input, select, textarea"));
      let hasPassword = false;
      let hasAddress = false;
      let hasPayment = false;

      for (const el of inputs) {
        if (!(el instanceof HTMLElement)) continue;
        const type = (el.getAttribute("type") || el.tagName.toLowerCase()).toLowerCase();
        const auto = (el.getAttribute("autocomplete") || "").toLowerCase();
        const name = (el.getAttribute("name") || el.id || el.getAttribute("placeholder") || "").toLowerCase();

        if (type === "password" || auto.includes("password") || auto.includes("username") || name.includes("password") || name.includes("login")) {
          hasPassword = true;
        }
        if (
          auto.includes("address") || auto.includes("postal") || auto.includes("country") || auto.includes("street") ||
          name.includes("street") || name.includes("address") || name.includes("zipcode") || name.includes("postal") || name.includes("city")
        ) {
          hasAddress = true;
        }
        if (
          auto.includes("cc-") || name.includes("cardnumber") || name.includes("card-number") || name.includes("card_number") ||
          name.includes("cvv") || name.includes("cvc") || name.includes("exp-date") || name.includes("exp_date")
        ) {
          hasPayment = true;
        }
      }

      const detected = [];
      if (hasPassword) detected.push("password");
      if (hasAddress) detected.push("address");
      if (hasPayment) detected.push("payment");
      return detected;
    } catch {
      return [];
    }
  })()`;
}

export function generateAutofillApplyScript(
	fillType: "password" | "address" | "payment",
	data: Record<string, string>,
): string {
	const json = JSON.stringify(data);
	return `(() => {
    try {
      const data = ${json};
      const fillType = ${JSON.stringify(fillType)};

      function setNativeValue(element, value) {
        if (!element || value === undefined || value === null) return false;
        try {
          element.focus();
          const proto = Object.getPrototypeOf(element);
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set ||
                         Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set ||
                         Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set ||
                         Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
          if (setter) {
            setter.call(element, String(value));
          } else {
            element.value = String(value);
          }
          element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
          element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
          element.dispatchEvent(new Event("blur", { bubbles: true, composed: true }));
          return true;
        } catch {
          return false;
        }
      }

      const inputs = Array.from(document.querySelectorAll("input, select, textarea"));
      let filledCount = 0;

      if (fillType === "password") {
        let passwordField = null;
        let usernameField = null;

        for (const el of inputs) {
          if (el.disabled || el.readOnly || el.type === "hidden") continue;
          const type = (el.getAttribute("type") || "").toLowerCase();
          const auto = (el.getAttribute("autocomplete") || "").toLowerCase();
          const name = (el.getAttribute("name") || el.id || el.getAttribute("placeholder") || "").toLowerCase();

          if (type === "password" || auto.includes("password") || name.includes("password") || name.includes("passwd")) {
            if (!passwordField) passwordField = el;
          } else if (
            type === "email" || type === "text" || auto.includes("username") || auto.includes("email") ||
            name.includes("user") || name.includes("login") || name.includes("email") || name.includes("account")
          ) {
            if (!usernameField) usernameField = el;
          }
        }

        if (usernameField && data.username) {
          if (setNativeValue(usernameField, data.username)) filledCount++;
        }
        if (passwordField && data.password) {
          if (setNativeValue(passwordField, data.password)) filledCount++;
        }
      } else if (fillType === "address") {
        for (const el of inputs) {
          if (el.disabled || el.readOnly || el.type === "hidden") continue;
          const auto = (el.getAttribute("autocomplete") || "").toLowerCase();
          const name = (el.getAttribute("name") || el.id || el.getAttribute("placeholder") || "").toLowerCase();
          const label = (el.labels?.[0]?.innerText || el.getAttribute("aria-label") || "").toLowerCase();
          const testStr = auto + " " + name + " " + label;

          if (data.fullName && (auto === "name" || testStr.includes("fullname") || testStr.includes("full-name") || testStr.includes("full_name") || (testStr.includes("name") && !testStr.includes("first") && !testStr.includes("last") && !testStr.includes("card") && !testStr.includes("user")))) {
            if (setNativeValue(el, data.fullName)) filledCount++;
          } else if (data.fullName && (auto === "given-name" || testStr.includes("first-name") || testStr.includes("firstname") || testStr.includes("first_name"))) {
            const firstName = data.fullName.split(" ")[0];
            if (setNativeValue(el, firstName)) filledCount++;
          } else if (data.fullName && (auto === "family-name" || testStr.includes("last-name") || testStr.includes("lastname") || testStr.includes("last_name"))) {
            const parts = data.fullName.split(" ");
            const lastName = parts.length > 1 ? parts.slice(1).join(" ") : "";
            if (setNativeValue(el, lastName)) filledCount++;
          } else if (data.streetAddress && (auto.includes("street-address") || auto.includes("address-line1") || testStr.includes("address1") || testStr.includes("addr1") || testStr.includes("street") || (testStr.includes("address") && !testStr.includes("2") && !testStr.includes("email")))) {
            if (setNativeValue(el, data.streetAddress)) filledCount++;
          } else if (data.streetAddressLine2 && (auto.includes("address-line2") || testStr.includes("address2") || testStr.includes("addr2") || testStr.includes("apt") || testStr.includes("suite"))) {
            if (setNativeValue(el, data.streetAddressLine2)) filledCount++;
          } else if (data.city && (auto.includes("address-level2") || testStr.includes("city") || testStr.includes("town"))) {
            if (setNativeValue(el, data.city)) filledCount++;
          } else if (data.state && (auto.includes("address-level1") || testStr.includes("state") || testStr.includes("province") || testStr.includes("region"))) {
            if (setNativeValue(el, data.state)) filledCount++;
          } else if (data.postalCode && (auto.includes("postal-code") || testStr.includes("zip") || testStr.includes("postal") || testStr.includes("postcode"))) {
            if (setNativeValue(el, data.postalCode)) filledCount++;
          } else if (data.country && (auto.includes("country") || testStr.includes("country"))) {
            if (setNativeValue(el, data.country)) filledCount++;
          } else if (data.phone && (auto.includes("tel") || testStr.includes("phone") || testStr.includes("tel") || testStr.includes("mobile"))) {
            if (setNativeValue(el, data.phone)) filledCount++;
          } else if (data.email && (auto.includes("email") || el.type === "email" || testStr.includes("email"))) {
            if (setNativeValue(el, data.email)) filledCount++;
          } else if (data.organization && (auto.includes("organization") || testStr.includes("company") || testStr.includes("organization") || testStr.includes("business"))) {
            if (setNativeValue(el, data.organization)) filledCount++;
          }
        }
      } else if (fillType === "payment") {
        for (const el of inputs) {
          if (el.disabled || el.readOnly || el.type === "hidden") continue;
          const auto = (el.getAttribute("autocomplete") || "").toLowerCase();
          const name = (el.getAttribute("name") || el.id || el.getAttribute("placeholder") || "").toLowerCase();
          const label = (el.labels?.[0]?.innerText || el.getAttribute("aria-label") || "").toLowerCase();
          const testStr = auto + " " + name + " " + label;

          if (data.cardNumber && (auto.includes("cc-number") || testStr.includes("cardnumber") || testStr.includes("card-number") || testStr.includes("card_number") || testStr.includes("cc-num") || testStr.includes("cardnum") || (testStr.includes("card") && testStr.includes("number")))) {
            if (setNativeValue(el, data.cardNumber)) filledCount++;
          } else if (data.cardholderName && (auto.includes("cc-name") || testStr.includes("cardholder") || testStr.includes("nameoncard") || testStr.includes("name-on-card") || testStr.includes("cc-name") || (testStr.includes("card") && testStr.includes("name")))) {
            if (setNativeValue(el, data.cardholderName)) filledCount++;
          } else if (data.expirationMonth && (auto.includes("cc-exp-month") || testStr.includes("exp-month") || testStr.includes("expmonth") || testStr.includes("exp_month") || testStr.includes("cc-month") || testStr === "mm")) {
            if (setNativeValue(el, data.expirationMonth)) filledCount++;
          } else if (data.expirationYear && (auto.includes("cc-exp-year") || testStr.includes("exp-year") || testStr.includes("expyear") || testStr.includes("exp_year") || testStr.includes("cc-year") || testStr === "yy" || testStr === "yyyy")) {
            if (setNativeValue(el, data.expirationYear)) filledCount++;
          } else if (data.expirationMonth && data.expirationYear && (auto.includes("cc-exp") || testStr.includes("expdate") || testStr.includes("exp-date") || testStr.includes("expiration") || testStr.includes("expiry"))) {
            const expFormatted = data.expirationMonth + "/" + (data.expirationYear.length === 4 ? data.expirationYear.slice(-2) : data.expirationYear);
            if (setNativeValue(el, expFormatted)) filledCount++;
          }
        }
      }

      return { success: true, filledCount };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  })()`;
}
