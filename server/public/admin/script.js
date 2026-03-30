// 予約情報を定期的に取得してテーブルに表示
function updateReservations() {
    fetch('/api/reservations')
        .then(response => response.json())
        .then(data => {
            const tableBody = document.getElementById('reservation-table-body');
            tableBody.innerHTML = '';

            data.forEach(reservation => {
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${reservation.id}</td>
                    <td>${reservation.name}</td>
                    <td>${reservation.contact}</td>
                    <td>${reservation.status}</td>
                    <td><img src="data:image/png;base64,${reservation.qr_code}" class="qr-code" alt="QR Code"></td>
                    <td>
                        <button onclick="updateStatus(${reservation.id}, 'checked-in')">入場</button>
                        <button onclick="updateStatus(${reservation.id}, 'cancelled')">キャンセル</button>
                        <button onclick="deleteReservation(${reservation.id})">削除</button>
                    </td>
                `;
                tableBody.appendChild(row);
            });
        })
        .catch(error => console.error('予約情報取得エラー:', error));
}




// リアルタイム入場者数を更新する機能
function updateAttendanceCount() {
    fetch('/api/attendance')
        .then(response => response.json())
        .then(data => {
            document.getElementById('attendance-count').textContent = `現在の入場者数: ${data.count}`;
        })
        .catch(error => console.error('入場者数取得エラー:', error));
}

// 予約のステータスを更新する
function updateStatus(id, status) {
    fetch(`/api/reservations/${id}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status })
    })
    .then(response => response.json())
    .then(data => {
        console.log(data.message);
        updateReservations();
    })
    .catch(error => console.error('ステータス更新エラー:', error));
}

// 予約を削除する
function deleteReservation(id) {
    fetch(`/api/reservations/${id}`, {
        method: 'DELETE'
    })
    .then(response => response.json())
    .then(data => {
        console.log(data.message);
        updateReservations();
    })
    .catch(error => console.error('予約削除エラー:', error));
}

// ゲスト検索機能
function searchGuests() {
    const query = document.getElementById('search-query').value;
    fetch(`/api/search?q=${query}`)
        .then(response => response.json())
        .then(data => {
            const searchResults = document.getElementById('search-results');
            searchResults.innerHTML = '<h3>検索結果</h3>';
            const resultTable = document.createElement('table');
            resultTable.innerHTML = `
                <thead>
                    <tr>
                        <th>ID</th>
                        <th>名前</th>
                        <th>連絡先</th>
                        <th>状態</th>
                    </tr>
                </thead>
                <tbody>
                    ${data.map(result => `
                        <tr>
                            <td>${result.id}</td>
                            <td>${result.name}</td>
                            <td>${result.contact}</td>
                            <td>${result.status}</td>
                        </tr>
                    `).join('')}
                </tbody>
            `;
            searchResults.appendChild(resultTable);
        })
        .catch(error => console.error('検索エラー:', error));
}

// QRコードスキャナーの初期化
function initQrScanner() {
    const html5QrCode = new Html5Qrcode("reader");
    html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 }, (decodedText, decodedResult) => {
        document.getElementById('result').textContent = `スキャン結果: ${decodedText}`;
        // QRコードスキャン後の処理
        fetch(`/api/verify?id=${decodedText}`)
            .then(response => response.json())
            .then(data => {
                document.getElementById('result').innerHTML = `
                    <h2>${data.message}</h2>
                    <ul>
                        <li><strong>ID:</strong> ${data.reservation.id}</li>
                        <li><strong>名前:</strong> ${data.reservation.name}</li>
                        <li><strong>連絡先:</strong> ${data.reservation.contact}</li>
                        <li><strong>関係:</strong> ${data.reservation.relationship}</li>
                        <li><strong>ステータス:</strong> ${data.reservation.status}</li>
                        <li><strong>作成日時:</strong> ${new Date(data.reservation.created_at).toLocaleString()}</li>
                    </ul>
                `;
            })
            .catch(error => console.error('QRコードスキャン後のエラー:', error));
    }).catch(error => {
        console.error('QRコードスキャンエラー:', error);
    });
}

// ページがロードされたときに呼ばれる関数
window.onload = () => {
    updateReservations();
    updateAttendanceCount();
    initQrScanner();
    setInterval(updateReservations, 5000); // 5秒ごとに予約情報を更新
    setInterval(updateAttendanceCount, 10000); // 10秒ごとに入場者数を更新
};
