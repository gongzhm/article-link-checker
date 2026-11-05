export async function withinBudget(work,ms=2800){
 let timer;
 try{return await Promise.race([work,new Promise(resolve=>{timer=setTimeout(resolve,ms);})]);}
 finally{clearTimeout(timer);}
}
