// SPDX-License-Identifier: BUSL-1.1

// ISO 3166-1: each country's two-letter code, number and English short
// name, as ADUC writes them to c, countryCode and co. A fixed table, so
// the name written doesn't change with the runtime's locale data.
const ISO_3166 = `
AD 020 Andorra
AE 784 United Arab Emirates
AF 004 Afghanistan
AG 028 Antigua and Barbuda
AI 660 Anguilla
AL 008 Albania
AM 051 Armenia
AO 024 Angola
AQ 010 Antarctica
AR 032 Argentina
AS 016 American Samoa
AT 040 Austria
AU 036 Australia
AW 533 Aruba
AX 248 Åland Islands
AZ 031 Azerbaijan
BA 070 Bosnia and Herzegovina
BB 052 Barbados
BD 050 Bangladesh
BE 056 Belgium
BF 854 Burkina Faso
BG 100 Bulgaria
BH 048 Bahrain
BI 108 Burundi
BJ 204 Benin
BL 652 Saint Barthélemy
BM 060 Bermuda
BN 096 Brunei
BO 068 Bolivia
BQ 535 Caribbean Netherlands
BR 076 Brazil
BS 044 Bahamas
BT 064 Bhutan
BV 074 Bouvet Island
BW 072 Botswana
BY 112 Belarus
BZ 084 Belize
CA 124 Canada
CC 166 Cocos (Keeling) Islands
CD 180 Congo (DRC)
CF 140 Central African Republic
CG 178 Congo
CH 756 Switzerland
CI 384 Côte d'Ivoire
CK 184 Cook Islands
CL 152 Chile
CM 120 Cameroon
CN 156 China
CO 170 Colombia
CR 188 Costa Rica
CU 192 Cuba
CV 132 Cabo Verde
CW 531 Curaçao
CX 162 Christmas Island
CY 196 Cyprus
CZ 203 Czechia
DE 276 Germany
DJ 262 Djibouti
DK 208 Denmark
DM 212 Dominica
DO 214 Dominican Republic
DZ 012 Algeria
EC 218 Ecuador
EE 233 Estonia
EG 818 Egypt
EH 732 Western Sahara
ER 232 Eritrea
ES 724 Spain
ET 231 Ethiopia
FI 246 Finland
FJ 242 Fiji
FK 238 Falkland Islands
FM 583 Micronesia
FO 234 Faroe Islands
FR 250 France
GA 266 Gabon
GB 826 United Kingdom
GD 308 Grenada
GE 268 Georgia
GF 254 French Guiana
GG 831 Guernsey
GH 288 Ghana
GI 292 Gibraltar
GL 304 Greenland
GM 270 Gambia
GN 324 Guinea
GP 312 Guadeloupe
GQ 226 Equatorial Guinea
GR 300 Greece
GS 239 South Georgia and the South Sandwich Islands
GT 320 Guatemala
GU 316 Guam
GW 624 Guinea-Bissau
GY 328 Guyana
HK 344 Hong Kong SAR
HM 334 Heard Island and McDonald Islands
HN 340 Honduras
HR 191 Croatia
HT 332 Haiti
HU 348 Hungary
ID 360 Indonesia
IE 372 Ireland
IL 376 Israel
IM 833 Isle of Man
IN 356 India
IO 086 British Indian Ocean Territory
IQ 368 Iraq
IR 364 Iran
IS 352 Iceland
IT 380 Italy
JE 832 Jersey
JM 388 Jamaica
JO 400 Jordan
JP 392 Japan
KE 404 Kenya
KG 417 Kyrgyzstan
KH 116 Cambodia
KI 296 Kiribati
KM 174 Comoros
KN 659 Saint Kitts and Nevis
KP 408 North Korea
KR 410 South Korea
KW 414 Kuwait
KY 136 Cayman Islands
KZ 398 Kazakhstan
LA 418 Laos
LB 422 Lebanon
LC 662 Saint Lucia
LI 438 Liechtenstein
LK 144 Sri Lanka
LR 430 Liberia
LS 426 Lesotho
LT 440 Lithuania
LU 442 Luxembourg
LV 428 Latvia
LY 434 Libya
MA 504 Morocco
MC 492 Monaco
MD 498 Moldova
ME 499 Montenegro
MF 663 Saint Martin
MG 450 Madagascar
MH 584 Marshall Islands
MK 807 North Macedonia
ML 466 Mali
MM 104 Myanmar
MN 496 Mongolia
MO 446 Macao SAR
MP 580 Northern Mariana Islands
MQ 474 Martinique
MR 478 Mauritania
MS 500 Montserrat
MT 470 Malta
MU 480 Mauritius
MV 462 Maldives
MW 454 Malawi
MX 484 Mexico
MY 458 Malaysia
MZ 508 Mozambique
NA 516 Namibia
NC 540 New Caledonia
NE 562 Niger
NF 574 Norfolk Island
NG 566 Nigeria
NI 558 Nicaragua
NL 528 Netherlands
NO 578 Norway
NP 524 Nepal
NR 520 Nauru
NU 570 Niue
NZ 554 New Zealand
OM 512 Oman
PA 591 Panama
PE 604 Peru
PF 258 French Polynesia
PG 598 Papua New Guinea
PH 608 Philippines
PK 586 Pakistan
PL 616 Poland
PM 666 Saint Pierre and Miquelon
PN 612 Pitcairn Islands
PR 630 Puerto Rico
PS 275 Palestine
PT 620 Portugal
PW 585 Palau
PY 600 Paraguay
QA 634 Qatar
RE 638 Réunion
RO 642 Romania
RS 688 Serbia
RU 643 Russia
RW 646 Rwanda
SA 682 Saudi Arabia
SB 090 Solomon Islands
SC 690 Seychelles
SD 729 Sudan
SE 752 Sweden
SG 702 Singapore
SH 654 Saint Helena
SI 705 Slovenia
SJ 744 Svalbard and Jan Mayen
SK 703 Slovakia
SL 694 Sierra Leone
SM 674 San Marino
SN 686 Senegal
SO 706 Somalia
SR 740 Suriname
SS 728 South Sudan
ST 678 São Tomé and Príncipe
SV 222 El Salvador
SX 534 Sint Maarten
SY 760 Syria
SZ 748 Eswatini
TC 796 Turks and Caicos Islands
TD 148 Chad
TF 260 French Southern Territories
TG 768 Togo
TH 764 Thailand
TJ 762 Tajikistan
TK 772 Tokelau
TL 626 Timor-Leste
TM 795 Turkmenistan
TN 788 Tunisia
TO 776 Tonga
TR 792 Turkey
TT 780 Trinidad and Tobago
TV 798 Tuvalu
TW 158 Taiwan
TZ 834 Tanzania
UA 804 Ukraine
UG 800 Uganda
UM 581 U.S. Minor Outlying Islands
US 840 United States
UY 858 Uruguay
UZ 860 Uzbekistan
VA 336 Vatican City
VC 670 Saint Vincent and the Grenadines
VE 862 Venezuela
VG 092 British Virgin Islands
VI 850 U.S. Virgin Islands
VN 704 Vietnam
VU 548 Vanuatu
WF 876 Wallis and Futuna
WS 882 Samoa
YE 887 Yemen
YT 175 Mayotte
ZA 710 South Africa
ZM 894 Zambia
ZW 716 Zimbabwe`;

/** A country as AD keeps it: three attributes that travel together. */
export interface DirectoryCountry {
  /** The two-letter code. */
  c: string;
  /** The country's English name. */
  co: string;
  /** Its ISO 3166 number, without leading zeros as AD stores it. */
  countryCode: string;
}

const COUNTRIES = new Map(
  ISO_3166.trim()
    .split('\n')
    .map((line): [string, DirectoryCountry] => {
      const [c, number] = line.split(' ', 2) as [string, string];
      return [c, { c, co: line.slice(7), countryCode: String(Number(number)) }];
    }),
);

/** The country with this two-letter code, or null for one ISO 3166 doesn't have. */
export function directoryCountry(code: string): DirectoryCountry | null {
  return COUNTRIES.get(code.toUpperCase()) ?? null;
}

/** Every country's two-letter code. */
export function directoryCountryCodes(): string[] {
  return [...COUNTRIES.keys()];
}
