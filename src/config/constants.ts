// Constantes de negócio — fonte única de verdade para cálculos financeiros.
// Qualquer valor de preço, taxa ou receita líquida deve vir daqui.

export const PRODUCT_PRICE = 97;
export const GATEWAY_FEE = 0.035;
export const NET_PER_SALE = +(PRODUCT_PRICE * (1 - GATEWAY_FEE)).toFixed(2); // 93.60
export const KIRVANO_FEE_RATE = GATEWAY_FEE;
