import sys, os
from PIL import Image, ImageDraw
d=sys.argv[1]; n=int(sys.argv[2]) if len(sys.argv)>2 else 12
fs=sorted(os.listdir(d)); print(d, len(fs), "frames", len(fs)/30, "s")
pick=[fs[round(i*(len(fs)-1)/(n-1))] for i in range(n)]
w,h=480,300; cols=4; rows=(n+cols-1)//cols
o=Image.new('RGB',(cols*(w+8),rows*(h+8)),'white')
for i,f in enumerate(pick):
    im=Image.open(os.path.join(d,f)).convert('RGB').resize((w,h))
    ImageDraw.Draw(im).text((6,6),f,fill=(0,255,0))
    o.paste(im,((i%cols)*(w+8),(i//cols)*(h+8)))
o.save(sys.argv[3] if len(sys.argv)>3 else 'sheet.png')
