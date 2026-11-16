MUSE AUTOMATION - CLEAN BUILD
=============================

CHAY TOOL
1. Mo run.bat.
2. Bam "Mo / Dang nhap Muse".
3. Dang nhap Muse.ai trong cua so Chrome rieng.
4. Bam "Kiem tra". Khi hien "Muse da dang nhap", tool san sang.
5. Chon nhieu anh san pham. Moi anh tao thanh mot luong rieng.
6. Nhap mot prompt bo cuc chung, bam "TAO LUONG" va "BAT DAU SAN XUAT".

CAC NUT CHINH
- Mo / Dang nhap Muse: mo profile Chrome rieng cua tool.
- Kiem tra: goi /api/session trong chinh phien Muse de kiem tra dang nhap.
- Hien / An Chrome: dua cua so Chrome ra man hinh hoac thu nho.
- Tao luong: moi anh san pham tao thanh mot job dung chung prompt bo cuc.
- Chay hang doi: voi tung san pham, tool tai anh len Muse, tao anh quang cao
  theo prompt, sau do dung chinh anh ket qua de tao video va tai MP4 ve may.
- Chay lai loi: dua job loi ve trang thai cho.
- Quet & tai: tim media dang hien thi tren trang Muse va tai ve data/downloads.
- Mo thu muc: mo thu muc media da tai.

DU LIEU
- data/state.json: cau hinh, hang doi va log.
- data/chrome-profile: profile dang nhap Muse.
- data/downloads: media da tai.

BAO MAT
- Tool khong co key kich hoat va khong co server dieu khien tu xa.
- Tool khong yeu cau OpenAI/Gemini API key.
- Cookie Muse nam trong data/chrome-profile. Khong chia se thu muc data.

GIOI HAN BAN 0.1
- Muse.ai la trang web thay doi lien tuc. Neu Muse doi bo cuc o nhap/nut Gui,
  selector tu dong co the can cap nhat.
- Trang thai tung luong hien ro: tai anh, tao anh, image-to-video, tai MP4.
- Quet media chi tai duoc URL anh/video dang hien thi va cho phep tai truc tiep.

MA NGUON
Thu muc source chua toan bo ma giao dien va automation duoc viet moi.
