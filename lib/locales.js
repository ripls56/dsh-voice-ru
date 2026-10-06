// Short UI language codes mapped to the model's BCP-47 locales.
// Shared by the host provider (lib/index.js) and the worker (lib/worker.js).
export const LOCALES = {
	ru: "ru-RU",
	en: "en-US",
	uk: "uk-UA",
	de: "de-DE",
	fr: "fr-FR",
	es: "es-ES",
	it: "it-IT",
	pt: "pt-BR",
	nl: "nl-NL",
	tr: "tr-TR",
	ar: "ar-AR",
	hi: "hi-IN",
	ja: "ja-JP",
	ko: "ko-KR",
	vi: "vi-VN",
	zh: "zh-CN",
	pl: "pl-PL",
	cs: "cs-CZ",
	sv: "sv-SE",
	nb: "nb-NO",
	da: "da-DK",
	fi: "fi-FI",
	ro: "ro-RO",
	sk: "sk-SK",
	bg: "bg-BG",
	hr: "hr-HR",
	hu: "hu-HU",
	et: "et-EE",
};

/** Normalize a language hint: "auto"/empty → null (autodetect), short code → locale, anything else passes through. */
export function toModelLanguage(language) {
	if (!language || language === "auto") return null;
	return LOCALES[language] ?? language;
}
