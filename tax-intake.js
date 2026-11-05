'use strict';
const {recentTaxYears}=require('./tax-years');
const {taxActionStart}=require('./tax-flow');
function taxIntakeTurn(p){
 if(p.client_reported_tax_years)return taxActionStart(p);
 const years=recentTaxYears(p),history=p.preparation_context?.intake?.tax_return_history;
 if(history==='filed_1_year')return {stage:'tax_years',scriptLine:'I see, based on your form, you’ve only filed one year of tax returns. Did you file '+years[0]+' or '+years[1]+'?'};
 if(history==='not_filed_recently')return {stage:'tax_intake_confirm',scriptLine:'I see, based on your form, you haven’t filed your recent tax returns, so you still need to file '+years[0]+' and '+years[1]+'. Is that correct?'};
 return {stage:'tax_years',scriptLine:'Which of your '+years.join(' and ')+' federal tax returns have you filed?'};
}
module.exports={taxIntakeTurn};
